import PgBoss from 'pg-boss';
import { config } from './config.js';
import { pgSsl, q } from './db.js';
import { apiBase, sendMail, templates, type Mail } from './lib/email.js';
import { fmtDate } from './lib/text.js';
import { grantFeatured, isFeatured, revokeFeatured, type ToolRow } from './lib/tools.js';
import type { PostRow } from './lib/posts.js';

export const boss = new PgBoss({
  connectionString: config.databaseUrl,
  ssl: pgSsl() as any,
  max: 3,
  schema: 'pgboss',
});

export const Q = {
  email: 'email',
  deploy: 'deploy',
  payments: 'payments',
  reminders: 'featured-reminders',
  dead: 'dead-letter',
} as const;

export const enqueueEmail = (mail: Mail) => boss.send(Q.email, mail);

/** Coalesces approvals: one rebuild about two minutes after the last approve. */
export const enqueueDeploy = (reason: string) =>
  boss.send(Q.deploy, { reason }, { singletonKey: 'deploy', singletonSeconds: 120, startAfter: 90 });

export async function startQueue(): Promise<void> {
  boss.on('error', (e) => console.error('[queue]', e));
  await boss.start();
  // The dead-letter queue must exist before any queue that points at it.
  if (!(await boss.getQueue(Q.dead))) await boss.createQueue(Q.dead, { name: Q.dead });
  for (const name of Object.values(Q)) {
    if (name !== Q.dead && !(await boss.getQueue(name))) {
      await boss.createQueue(name, { name, retryLimit: 5, retryDelay: 30, retryBackoff: true, deadLetter: Q.dead });
    }
  }

  await boss.work<Mail>(Q.email, async ([job]) => {
    await sendMail(job.data);
  });
  await boss.work<{ reason: string }>(Q.deploy, async ([job]) => {
    await runDeploy(job.data.reason);
  });
  await boss.work<{ eventId: string }>(Q.payments, async ([job]) => {
    await processPaymentEvent(job.data.eventId);
  });
  await boss.work(Q.reminders, async () => {
    await sendFeaturedReminders();
    await expirePendingOrders();
    await requeueStrandedWebhooks();
  });
  await boss.work<any>(Q.dead, async ([job]) => {
    const d = job.data ?? {};
    await sendMail(templates.ownerJobFailed({ queue: String(d.queue ?? job.name), error: String(d.error ?? 'unknown'), data: d }));
  });

  await boss.schedule(Q.reminders, '0 9 * * *', {}, { tz: 'UTC' });
  await boss.schedule(Q.deploy, '0 3 * * 1', { reason: 'weekly rebuild so featured expiry takes effect' }, { tz: 'UTC' });
  console.log('[queue] started');
}

export async function stopQueue(): Promise<void> {
  await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
}

async function runDeploy(reason: string): Promise<void> {
  if (!config.deployHookUrl) {
    console.warn(`[deploy] CF_DEPLOY_HOOK_URL not set. Skipping rebuild (${reason}).`);
    return;
  }
  const res = await fetch(config.deployHookUrl, { method: 'POST' });
  if (!res.ok) throw new Error(`Deploy hook returned ${res.status}`);
  console.log(`[deploy] triggered (${reason})`);
  // Tell submitters their page is live once the build has had time to finish.
  const tools = (await q<ToolRow>("select * from tools where status = 'published' and live_notified_at is null and submitter_email is not null")).rows;
  for (const t of tools) {
    const url = `${config.siteUrl}/tools/${t.slug}/`;
    const mail = t.profile_tier === 'basic' && !isFeatured(t)
      ? templates.toolBasicLive({ to: t.submitter_email!, name: t.submitter_name ?? '', toolName: t.name, url, token: t.edit_token })
      : templates.toolLive({ to: t.submitter_email!, name: t.submitter_name ?? '', toolName: t.name, url, featured: isFeatured(t), token: t.edit_token });
    await boss.send(Q.email, mail, { startAfter: 240 });
    await q('update tools set live_notified_at = now() where id = $1', [t.id]);
  }
  const posts = (await q<PostRow>("select * from posts where status = 'published' and live_notified_at is null and submitter_email is not null")).rows;
  for (const p of posts) {
    await boss.send(Q.email, templates.articleLive({ to: p.submitter_email!, name: p.submitter_name ?? '', title: p.title, url: `${config.siteUrl}/blog/${p.slug}/` }), { startAfter: 240 });
    await q('update posts set live_notified_at = now() where id = $1', [p.id]);
  }
}

async function sendFeaturedReminders(): Promise<void> {
  const { rows } = await q<ToolRow>(
    `select * from tools where plan = 'featured' and status = 'published' and submitter_email is not null and reminder_sent_at is null
       and paid_until between now() + interval '29 days' and now() + interval '31 days'`,
  );
  for (const t of rows) {
    await boss.send(Q.email, templates.featuredExpiring({
      to: t.submitter_email!, name: t.submitter_name ?? '', toolName: t.name, until: fmtDate(t.paid_until),
      renewUrl: `${apiBase()}/checkout/featured-renewal/${t.id}`,
    }));
    await q('update tools set reminder_sent_at = now() where id = $1', [t.id]);
  }
}

type OrderRow = { id: string; kind: string; tool_id: string | null; email: string | null; name: string | null; amount_cents: number; currency: string; status: string; metadata: Record<string, any> };

/** Checkouts nobody finished are closed after a while so the orders list stays honest. Nothing is deleted. */
async function expirePendingOrders(): Promise<void> {
  const { rowCount } = await q("update orders set status = 'expired' where status = 'pending' and created_at < now() - make_interval(days => $1)", [config.pendingOrderDays]);
  if (rowCount) console.log(`[orders] expired ${rowCount} unpaid order(s)`);
}

/** A webhook row whose queue job was never created (send failed after the insert) would otherwise sit unprocessed forever. */
async function requeueStrandedWebhooks(): Promise<void> {
  const { rows } = await q<{ id: string }>("select id from webhook_events where processed_at is null and error is null and received_at < now() - interval '10 minutes'");
  for (const r of rows) await boss.send(Q.payments, { eventId: r.id }, { singletonKey: r.id });
  if (rows.length) console.log(`[webhooks] re-queued ${rows.length} stranded event(s)`);
}

/** Private links for everything an order pays for, for the confirmation email and the thank-you page. */
export async function orderLinks(order: OrderRow): Promise<[string, string][]> {
  const links: [string, string][] = [];
  const base = apiBase();
  const toolIds: string[] = order.kind === 'bundle' ? (order.metadata.tool_ids ?? []) : order.tool_id ? [order.tool_id] : [];
  for (const id of toolIds) {
    const t = (await q<{ name: string; edit_token: string | null; listing_complete: boolean }>('select name, edit_token, listing_complete from tools where id = $1', [id])).rows[0];
    if (t?.edit_token) links.push([`${t.listing_complete ? 'Listing' : 'Complete listing'}: ${t.name}`, `${base}/s/${t.edit_token}`]);
  }
  const posts = (await q<{ title: string; edit_token: string | null; listing_complete: boolean }>('select title, edit_token, listing_complete from posts where order_id = $1 order by created_at', [order.id])).rows;
  for (const p of posts) if (p.edit_token) links.push([`${p.listing_complete ? 'Article' : 'Add the draft'}: ${p.title}`, `${base}/s/${p.edit_token}`]);
  return links;
}

async function processPaymentEvent(eventId: string): Promise<void> {
  const { rows } = await q<{ id: string; type: string; payload: any; processed_at: Date | null }>('select * from webhook_events where id = $1', [eventId]);
  const ev = rows[0];
  if (!ev || ev.processed_at) return;
  const data = ev.payload?.data ?? {};
  const meta = data.metadata ?? {};
  const paymentId: string | undefined = data.payment_id ?? data.id;
  const customerEmail: string | undefined = data.customer?.email;
  const customerName: string | undefined = data.customer?.name;

  try {
    if (ev.type === 'payment.succeeded') {
      const order = await findOrder(meta.order_id, paymentId);
      if (!order) throw new Error(`No order for payment ${paymentId} (order_id ${meta.order_id ?? 'missing'})`);
      // Atomic claim: only the first event (or retry) to flip the order to paid grants placement and sends emails.
      // A duplicate webhook or an admin retry finds no row and does nothing, so a 12 month term can never become 24.
      const paidAt = new Date();
      const claimed = await q(
        `update orders set status = 'paid', paid_at = $5, provider_payment_id = coalesce($2, provider_payment_id),
           email = coalesce(email, $3), name = coalesce(name, $4) where id = $1 and status <> 'paid' returning id`,
        [order.id, paymentId ?? null, customerEmail ?? null, customerName ?? null, paidAt],
      );
      if (claimed.rowCount) {
        let next = 'A person contacts you within one business day.';
        if (order.kind === 'bundle') {
          for (const id of (order.metadata.tool_ids ?? []) as string[]) await grantFeatured(id, config.featuredTermDays);
          next = 'Complete each listing or article from its private link below. Directory submissions, when included, start within one business day and the spreadsheet of live listings follows within seven.';
        } else if (order.kind === 'featured' && order.tool_id) {
          await grantFeatured(order.tool_id, config.featuredTermDays);
          const t = (await q<ToolRow>('select * from tools where id = $1', [order.tool_id])).rows[0];
          next = t?.status === 'published'
            ? 'Your listing is already live and moves to the top of its category with a dofollow link within a few minutes.'
            : 'Your listing is in the review queue. Featured placement switches on the moment it is approved, usually within five business days.';
          if (t?.status === 'published') await enqueueDeploy(`featured paid for ${t.slug}`);
        } else if (order.kind === 'instant' && order.tool_id) {
          // Skip the queue: publish now, rebuild, and let the editor read it from the live list. A decline later refunds.
          const { rowCount } = await q("update tools set status = 'published', published_at = coalesce(published_at, now()), updated_at = now() where id = $1 and status in ('pending', 'changes_requested')", [order.tool_id]);
          if (rowCount) await enqueueDeploy(`instant publish paid for ${order.tool_id}`);
          next = 'Your listing publishes within the next few minutes and is live within 24 hours at the latest. An editor reads it afterwards; if it is declined you are refunded in full.';
        } else if (order.kind === 'sponsored') {
          next = 'The editor confirms a publication date within one business day once the draft is in. Most articles are live within three business days.';
        } else if (order.kind === 'directory_package') {
          next = 'We contact you within one business day for the product details, then submissions start. The spreadsheet of live listings follows within seven business days.';
        }
        const to = customerEmail ?? order.email;
        const links = await orderLinks(order);
        if (to) await enqueueEmail(templates.orderPaid({ to, name: customerName ?? order.name ?? '', what: describe(order), amountCents: order.amount_cents, currency: order.currency, next, orderId: order.id, paidAt, links }));
        await enqueueEmail(templates.ownerNew({
          subject: `Payment: ${describe(order)}`,
          details: [['From', to ?? 'unknown'], ['Amount', `${(order.amount_cents / 100).toFixed(2)} ${order.currency}`], ['Order', order.id]],
          adminUrl: `${apiBase()}/admin?tab=orders`,
        }));
      }
    } else if (ev.type === 'refund.succeeded' || ev.type === 'payment.refunded') {
      const order = await findOrder(meta.order_id, paymentId);
      if (order) {
        await q("update orders set status = 'refunded' where id = $1", [order.id]);
        const toolIds: string[] = order.kind === 'bundle' ? (order.metadata.tool_ids ?? []) : order.kind === 'featured' && order.tool_id ? [order.tool_id] : [];
        for (const id of toolIds) await revokeFeatured(id);
        if (toolIds.length) await enqueueDeploy(`refund for order ${order.id}`);
      }
    } else if (ev.type === 'payment.failed') {
      const order = await findOrder(meta.order_id, paymentId);
      if (order && order.status === 'pending') await q("update orders set status = 'failed' where id = $1", [order.id]);
    }
    await q('update webhook_events set processed_at = now(), error = null where id = $1', [eventId]);
  } catch (e) {
    await q('update webhook_events set error = $2 where id = $1', [eventId, String(e)]);
    throw e;
  }
}

async function findOrder(orderId?: string, paymentId?: string): Promise<OrderRow | null> {
  if (orderId) {
    const r = await q<OrderRow>('select * from orders where id::text = $1', [orderId]);
    if (r.rows[0]) return r.rows[0];
  }
  if (paymentId) {
    const r = await q<OrderRow>('select * from orders where provider_payment_id = $1', [paymentId]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

const KIND_LABEL: Record<string, string> = { featured: 'Featured listing (12 months)', sponsored: 'Sponsored article', directory_package: 'Directory and listicle package', writing_addon: 'Writing add-on', instant: 'Instant publish' };
export const describe = (o: { kind: string; metadata?: Record<string, any> }): string => {
  if (o.kind === 'bundle') {
    const items = (o.metadata?.items ?? []) as { kind: string; qty: number }[];
    return items.map((i) => `${i.qty > 1 ? `${i.qty} x ` : ''}${KIND_LABEL[i.kind] ?? i.kind}`).join(', ') || 'Bundle';
  }
  return KIND_LABEL[o.kind] ?? o.kind;
};
