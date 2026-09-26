import PgBoss from 'pg-boss';
import { config } from './config.js';
import { q } from './db.js';
import { apiBase, sendMail, templates, type Mail } from './lib/email.js';
import { fmtDate } from './lib/text.js';
import { grantFeatured, isFeatured, revokeFeatured, type ToolRow } from './lib/tools.js';
import type { PostRow } from './lib/posts.js';

const isLocal = /localhost|127\.0\.0\.1/.test(config.databaseUrl);

export const boss = new PgBoss({
  connectionString: config.databaseUrl,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
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
    await boss.send(Q.email, templates.toolLive({ to: t.submitter_email!, name: t.submitter_name ?? '', toolName: t.name, url: `${config.siteUrl}/tools/${t.slug}/`, featured: isFeatured(t), token: (t as any).edit_token }), { startAfter: 240 });
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
      if (order.status !== 'paid') {
        const paidAt = new Date();
        await q(
          `update orders set status = 'paid', paid_at = $5, provider_payment_id = coalesce($2, provider_payment_id),
             email = coalesce(email, $3), name = coalesce(name, $4) where id = $1`,
          [order.id, paymentId ?? null, customerEmail ?? null, customerName ?? null, paidAt],
        );
        let next = 'We will be in touch within one business day.';
        if (order.kind === 'featured' && order.tool_id) {
          await grantFeatured(order.tool_id, config.featuredTermDays);
          const t = (await q<ToolRow>('select * from tools where id = $1', [order.tool_id])).rows[0];
          next = t?.status === 'published'
            ? 'Your listing is already live and moves to the top of its category with a dofollow link within a few minutes.'
            : 'Your listing is in the review queue. Featured placement switches on the moment it is approved, usually within five business days.';
          if (t?.status === 'published') await enqueueDeploy(`featured paid for ${t.slug}`);
        } else if (order.kind === 'sponsored') {
          next = 'We review the draft or pitch and reply within one business day with a publication date, normally within three business days.';
        } else if (order.kind === 'directory_package') {
          next = 'We email you within one business day to collect the product details and start submissions. The full spreadsheet of live listings follows within seven business days.';
        }
        const to = customerEmail ?? order.email;
        if (to) await enqueueEmail(templates.orderPaid({ to, name: customerName ?? order.name ?? '', what: describe(order), amountCents: order.amount_cents, currency: order.currency, next, orderId: order.id, paidAt }));
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
        if (order.kind === 'featured' && order.tool_id) {
          await revokeFeatured(order.tool_id);
          await enqueueDeploy(`refund for order ${order.id}`);
        }
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

export const describe = (o: { kind: string }): string =>
  ({ featured: 'Featured listing (12 months)', sponsored: 'Sponsored article', directory_package: 'Directory and listicle package' } as Record<string, string>)[o.kind] ?? o.kind;
