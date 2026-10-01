import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { renderMarkdown } from '../lib/markdown.js';
import { config } from '../config.js';
import { q } from '../db.js';
import { apiBase, templates } from '../lib/email.js';
import { layout, stars, statusPill } from '../lib/html.js';
import { getPost, type PostRow } from '../lib/posts.js';
import { processPostImage, processThumbnail, uploadFile, uploadThumbnail } from '../lib/storage.js';
import { clean, cleanLine, esc, fmtDate, lines, money, multi, parseTags, uniqueSlug } from '../lib/text.js';
import { dateOnly, getTool, grantFeatured, isFeatured, revokeFeatured, saveComparisonFields, type ComparisonFields, type ToolRow } from '../lib/tools.js';
import { allComparisons, getComparison, orderPair, upsertComparison, type ComparisonRow } from '../lib/comparisons.js';
import { comparisonFields } from '../lib/forms.js';
import { FEATURES, OTHER_CATEGORY, PRICING, VERTICALS, getVertical, isValidCategory } from '../taxonomy.js';
import { boss, describe, enqueueDeploy, enqueueEmail, Q } from '../queue.js';

const COOKIE = 'lantle_admin';
type Body = Record<string, unknown>;
const str = (b: Body, k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
const go = (reply: FastifyReply, path: string, flash?: string, err = false) =>
  reply.code(303).redirect(`${path}${flash ? `${path.includes('?') ? '&' : '?'}flash=${encodeURIComponent(flash)}${err ? '&err=1' : ''}` : ''}`);
const flashOf = (req: FastifyRequest) => {
  const qs = req.query as Record<string, string>;
  return { flash: qs.flash, flashKind: (qs.err ? 'err' : 'ok') as 'ok' | 'err' };
};
const REVIEW = ['pending', 'changes_requested'];

/**
 * Login lockout that does not depend on the client IP (X-Forwarded-For is attacker controlled, and the rate limiter is per IP).
 * One shared admin password means one shared counter: after LOCK_AFTER failures every attempt waits out a doubling delay.
 */
const LOCK_AFTER = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;
const lock = { failures: 0, until: 0 };
const lockedFor = (): number => Math.max(0, lock.until - Date.now());
const noteFailure = () => {
  lock.failures++;
  if (lock.failures >= LOCK_AFTER) lock.until = Date.now() + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (lock.failures - LOCK_AFTER));
};

export default async function adminRoutes(app: FastifyInstance) {
  // ---- auth ----
  app.get('/admin/login', async (req, reply) => {
    reply.type('text/html');
    return layout('Log in', `<div class="card" style="max-width:24rem;margin:3rem auto"><h1>Log in</h1>
      <form class="stack" method="post" action="/admin/login"><label>Password <input type="password" name="password" autofocus required /></label><button class="btn" type="submit">Log in</button></form></div>`, { nav: false, ...flashOf(req) });
  });
  app.post('/admin/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const wait = lockedFor();
    if (wait > 0) {
      req.log.warn({ failures: lock.failures }, 'admin login locked');
      return go(reply, '/admin/login', `Too many wrong passwords. Try again in ${Math.ceil(wait / 1000)} seconds.`, true);
    }
    const given = Buffer.from(str(req.body as Body, 'password'));
    const want = Buffer.from(config.admin.password);
    const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      noteFailure();
      req.log.warn({ failures: lock.failures }, 'admin login failed');
      return go(reply, '/admin/login', 'Wrong password.', true);
    }
    lock.failures = 0;
    lock.until = 0;
    const token = crypto.randomBytes(32).toString('hex');
    await q("insert into admin_sessions (token, expires_at) values ($1, now() + interval '30 days')", [token]);
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProd, signed: true, maxAge: 30 * 24 * 3600 });
    return reply.code(303).redirect('/admin');
  });
  app.post('/admin/logout', async (req, reply) => {
    const c = req.unsignCookie(req.cookies[COOKIE] ?? '');
    if (c.valid && c.value) await q('delete from admin_sessions where token = $1', [c.value]);
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.code(303).redirect('/admin/login');
  });
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/admin') || req.url.startsWith('/admin/login')) return;
    const c = req.unsignCookie(req.cookies[COOKIE] ?? '');
    const ok = c.valid && c.value && (await q('select 1 from admin_sessions where token = $1 and expires_at > now()', [c.value])).rowCount;
    if (!ok) return reply.code(303).redirect('/admin/login');
  });

  // ---- dashboard ----
  app.get('/admin', async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const tab = qs.tab || 'queue';
    reply.type('text/html');
    let body = '';
    const rebuild = `<form method="post" action="/admin/deploy"><button class="btn ghost sm" type="submit">Rebuild site now</button></form>`;
    if (tab === 'queue') {
      const tools = (await q<ToolRow>("select * from tools where status = any($1) order by updated_at desc", [REVIEW])).rows;
      const posts = (await q<any>("select p.*, o.status as order_status from posts p left join orders o on o.id = p.order_id where p.status = any($1) order by p.updated_at desc", [REVIEW])).rows;
      body = `<div class="row" style="justify-content:space-between"><h1>Review queue</h1>${rebuild}</div>
        <h2 style="margin-top:0">Tools <span class="pill grey">${tools.length}</span></h2>${tools.length ? toolsTable(tools) : '<p class="muted">Nothing waiting.</p>'}
        <h2>Articles <span class="pill grey">${posts.length}</span></h2>${posts.length ? postsTable(posts) : '<p class="muted">Nothing waiting.</p>'}`;
    } else if (tab === 'articles') {
      const status = qs.status || '';
      const posts = (await q<any>(`select p.*, o.status as order_status from posts p left join orders o on o.id = p.order_id ${status ? 'where p.status = $1' : ''} order by case p.status when 'pending' then 0 when 'changes_requested' then 1 when 'published' then 2 else 3 end, p.pub_date desc limit 500`, status ? [status] : [])).rows;
      const chips = ['', 'pending', 'changes_requested', 'published', 'rejected'].map((s) => `<a class="pill ${s === status ? '' : 'grey'}" href="/admin?tab=articles${s ? `&status=${s}` : ''}">${s ? s.replace('_', ' ') : 'all'}</a>`).join(' ');
      body = `<div class="row" style="justify-content:space-between"><h1>Articles <span class="pill grey">${posts.length}</span></h1><div class="row"><form method="post" action="/admin/posts/new"><button class="btn sm" type="submit">New article</button></form>${rebuild}</div></div>
        <p class="row" style="margin:0 0 1rem">${chips}</p>${posts.length ? postsTable(posts) : '<p class="muted">No articles.</p>'}`;
    } else if (tab === 'published' || tab === 'rejected') {
      const { rows } = await q<ToolRow>(`select * from tools where status = $1 order by ${tab === 'published' ? 'published_at desc nulls last' : 'updated_at desc'} limit 500`, [tab]);
      body = `<div class="row" style="justify-content:space-between"><h1>${tab === 'published' ? 'Published tools' : 'Rejected tools'} <span class="pill grey">${rows.length}</span></h1>${rebuild}</div>${rows.length ? toolsTable(rows) : '<p class="muted">Nothing here.</p>'}`;
    } else if (tab === 'comparisons') {
      const rows = await allComparisons();
      const names = await toolNames(rows.flatMap((c) => [c.tool_a, c.tool_b]));
      body = `<div class="row" style="justify-content:space-between"><h1>Editorial comparisons <span class="pill grey">${rows.length}</span></h1>
        <form method="post" action="/admin/comparisons/new" class="row"><input name="tool_a" placeholder="slug a" required style="max-width:12rem"><input name="tool_b" placeholder="slug b" required style="max-width:12rem"><button class="btn sm" type="submit">New verdict</button></form></div>
        <p class="meta">Every pair of tools already gets a data-driven compare page. A row here adds a hand-written verdict, the pick lists and an optional winner on top. Featured placement never shows here and never affects a verdict.</p>
        ${rows.length ? `<table><tr><th>Pair</th><th>Winner</th><th>Status</th><th>Reviewed</th><th>Updated</th><th></th></tr>${rows.map((c) => `<tr>
          <td><a href="/admin/comparisons/${c.id}"><strong>${esc(names.get(c.tool_a) ?? c.tool_a)} vs ${esc(names.get(c.tool_b) ?? c.tool_b)}</strong></a><br><span class="meta">/tools/compare/${esc(c.tool_a)}-vs-${esc(c.tool_b)}/</span></td>
          <td>${c.winner ? esc(names.get(c.winner) ?? c.winner) : '<span class="muted">no call</span>'}</td><td>${statusPill(c.status)}</td>
          <td class="meta">${c.reviewed_at ? dateOnly(c.reviewed_at) : '<span class="pill warn">not reviewed</span>'}</td><td class="meta">${fmtDate(c.updated_at)}</td>
          <td><a class="btn ghost sm" href="/admin/comparisons/${c.id}">Open</a></td></tr>`).join('')}</table>` : '<p class="muted">No editorial verdicts yet.</p>'}`;
    } else if (tab === 'orders') {
      const orders = (await q<any>('select o.*, t.name as tool_name, p.title as post_title, p.id as post_id from orders o left join tools t on t.id = o.tool_id left join posts p on p.order_id = o.id order by o.created_at desc limit 300')).rows;
      body = `<h1>Orders</h1>${orders.length ? `<table><tr><th>When</th><th>What</th><th>Customer</th><th>Amount</th><th>Status</th><th>Ref</th></tr>${orders.map((o: any) => `<tr><td>${fmtDate(o.created_at)}</td><td>${esc(describe(o))}${o.tool_name ? `<br><a href="/admin/tools/${o.tool_id}">${esc(o.tool_name)}</a>` : ''}${o.post_title ? `<br><a href="/admin/posts/${o.post_id}">${esc(o.post_title)}</a>` : ''}</td><td>${esc(o.name ?? '')}<br><span class="meta">${esc(o.email ?? '')}</span></td><td>${money(o.amount_cents, o.currency)}${o.discount_cents ? `<br><span class="meta">bundle discount ${money(o.discount_cents, o.currency)}</span>` : ''}</td><td>${statusPill(o.status)}</td><td class="meta">${esc(o.provider_payment_id ?? o.provider_session_id ?? '')}<br>${esc(o.id)}</td></tr>`).join('')}</table>` : '<p class="muted">No orders yet.</p>'}`;
    } else if (tab === 'messages') {
      const { rows } = await q<any>('select * from messages order by created_at desc limit 300');
      body = `<h1>Messages</h1>${rows.length ? rows.map((m: any) => `<div class="card" id="m-${m.id}" style="margin-bottom:1rem"><div class="row" style="justify-content:space-between"><strong>${esc(m.name || m.email)}</strong><span class="pill grey">${esc(m.kind.replace('_', ' '))}</span></div><p class="meta"><a href="mailto:${esc(m.email)}">${esc(m.email)}</a>${m.company ? ` · ${esc(m.company)}` : ''}${m.interest ? ` · ${esc(m.interest)}` : ''} · ${fmtDate(m.created_at)}</p><pre>${esc(m.message)}</pre></div>`).join('') : '<p class="muted">No messages yet.</p>'}`;
    } else if (tab === 'subscribers') {
      const { rows } = await q<any>('select * from subscribers where unsubscribed_at is null order by created_at desc');
      body = `<h1>Subscribers <span class="pill grey">${rows.length}</span></h1><p class="meta">Copy the list into your newsletter tool when you send.</p><pre>${rows.map((s: any) => esc(s.email)).join('\n')}</pre>`;
    } else if (tab === 'jobs') {
      const failed = (await q<any>("select id, name, data, output, retry_count, created_on from pgboss.job where state = 'failed' order by created_on desc limit 100")).rows;
      const recent = (await q<any>("select name, state, count(*)::int as n from pgboss.job where created_on > now() - interval '7 days' group by name, state order by name, state")).rows;
      body = `<h1>Background jobs</h1><h2>Last 7 days</h2><table><tr><th>Queue</th><th>State</th><th>Count</th></tr>${recent.map((r: any) => `<tr><td>${esc(r.name)}</td><td>${statusPill(r.state)}</td><td>${r.n}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No jobs yet.</td></tr>'}</table>
        <h2>Failed</h2>${failed.length ? failed.map((j: any) => `<div class="card" style="margin-bottom:1rem"><div class="row" style="justify-content:space-between"><strong>${esc(j.name)}</strong><form method="post" action="/admin/jobs/retry"><input type="hidden" name="name" value="${esc(j.name)}"><input type="hidden" name="data" value="${esc(JSON.stringify(j.data))}"><button class="btn sm" type="submit">Retry</button></form></div><p class="meta">${fmtDate(j.created_on)} · ${j.retry_count} retries</p><pre>${esc(JSON.stringify(j.output ?? {}, null, 1)).slice(0, 1200)}</pre></div>`).join('') : '<p class="muted">Nothing failed.</p>'}`;
    }
    return layout(tab, body, { tab, ...flashOf(req) });
  });

  app.post('/admin/jobs/retry', async (req, reply) => {
    const b = req.body as Body;
    const name = str(b, 'name');
    if (!(Object.values(Q) as string[]).includes(name)) return go(reply, '/admin?tab=jobs', 'Unknown queue.', true);
    await boss.send(name, JSON.parse(str(b, 'data') || '{}'));
    return go(reply, '/admin?tab=jobs', 'Job re-queued.');
  });
  app.post('/admin/deploy', async (_req, reply) => {
    await enqueueDeploy('manual');
    return go(reply, '/admin', 'Rebuild queued. The site updates in a few minutes.');
  });

  // ======================= TOOLS =======================
  app.get('/admin/tools/:id', async (req, reply) => {
    const t = await getTool((req.params as { id: string }).id);
    if (!t) return reply.code(404).send('Not found');
    const orders = (await q<any>('select * from orders where tool_id = $1 order by created_at desc', [t.id])).rows;
    reply.type('text/html');
    return layout(t.name, toolPage(t, orders), { tab: REVIEW.includes(t.status) ? 'queue' : t.status, ...flashOf(req) });
  });

  app.post('/admin/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Body;
    const vertical = cleanLine(str(b, 'vertical'), 40);
    if (!getVertical(vertical)) return go(reply, `/admin/tools/${id}`, 'Unknown category.', true);
    const rating = Number(str(b, 'rating')) || null;
    const ratingOk = rating !== null && rating >= 1 && rating <= 5 && Number.isInteger(rating * 2);
    await q(
      `update tools set name=$2, website=$3, tagline=$4, vertical=$5, category=$6, pricing=$7, best_for=$8, rating=$9, editors_pick=$10, body_md=$11, notes=$12, slug=$13, updated_at=now() where id=$1`,
      [id, cleanLine(str(b, 'name'), 80), cleanLine(str(b, 'website'), 300), cleanLine(str(b, 'tagline'), 140), vertical, cleanLine(str(b, 'category'), 60),
        (PRICING as readonly string[]).includes(str(b, 'pricing')) ? str(b, 'pricing') : 'Paid', cleanLine(str(b, 'best_for'), 120),
        ratingOk ? rating : null, str(b, 'editors_pick') !== '', String(b['body_md'] ?? '').replace(/\r\n?/g, '\n'), clean(str(b, 'notes'), 2000) || null,
        cleanLine(str(b, 'slug'), 60).toLowerCase().replace(/[^a-z0-9-]/g, '-')],
    );
    const t = await getTool(id);
    if (t?.status === 'published') await enqueueDeploy(`edited ${t.slug}`);
    return go(reply, `/admin/tools/${id}`, t?.status === 'published' ? 'Saved. Rebuild queued.' : 'Saved.');
  });

  app.post('/admin/tools/:id/comparison', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await getTool(id);
    if (!t) return reply.code(404).send('Not found');
    const b = req.body as Body;
    const trial = parseInt(str(b, 'trial_days'), 10);
    const free = str(b, 'free_tier');
    const f: ComparisonFields = {
      pros: lines(str(b, 'pros'), 5, 120), cons: lines(str(b, 'cons'), 4, 120), key_features: multi(b['key_features']).slice(0, 12), platforms: multi(b['platforms']),
      integrations: lines(str(b, 'integrations'), 10, 40, true), starting_price: cleanLine(str(b, 'starting_price'), 60) || null,
      free_tier: free === 'yes' ? true : free === 'no' ? false : null, trial_days: Number.isFinite(trial) && trial >= 0 && trial <= 365 ? trial : null,
      deployment: cleanLine(str(b, 'deployment'), 20) || null, company_size: multi(b['company_size']), verdict_line: cleanLine(str(b, 'verdict_line'), 160) || null,
      deal_text: cleanLine(str(b, 'deal_text'), 120) || null, deal_code: cleanLine(str(b, 'deal_code'), 40) || null, deal_url: cleanLine(str(b, 'deal_url'), 300) || null,
      deal_until: /^\d{4}-\d{2}-\d{2}$/.test(str(b, 'deal_until')) ? str(b, 'deal_until') : null,
    };
    const checked = str(b, 'action') === 'verified';
    await saveComparisonFields(id, t.vertical, f, checked);
    if (t.status === 'published') await enqueueDeploy(`comparison data ${t.slug}`);
    return go(reply, `/admin/tools/${id}#comparison`, checked ? 'Saved and marked as checked today.' : 'Comparison data saved.');
  });

  app.post('/admin/tools/:id/thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await getTool(id);
    const file = (req.body as Body)['thumbnail'];
    if (!t || !Buffer.isBuffer(file) || !file.length) return go(reply, `/admin/tools/${id}`, 'No image received.', true);
    try {
      const url = await uploadThumbnail(t.slug, await processThumbnail(file));
      await q('update tools set thumbnail_url = $2, updated_at = now() where id = $1', [id, url]);
      if (t.status === 'published') await enqueueDeploy(`thumbnail ${t.slug}`);
      return go(reply, `/admin/tools/${id}`, 'Thumbnail updated.');
    } catch (e) {
      return go(reply, `/admin/tools/${id}`, (e as Error).message, true);
    }
  });

  app.post('/admin/tools/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await getTool(id);
    if (!t) return reply.code(404).send('Not found');
    const problems: string[] = [];
    if (!isValidCategory(t.vertical, t.category)) problems.push(`pick a real subcategory (currently "${t.category}")`);
    // A basic (free) profile publishes with the card fields and a short "what it does" paragraph; the full profile needs the whole review.
    const basic = t.profile_tier === 'basic' && t.plan !== 'featured';
    if (t.body_md.trim().length < (basic ? 40 : 100)) problems.push(basic ? 'the "what it does" paragraph is too short' : 'the review body is too short');
    if (t.tagline.length < 10) problems.push('the tagline is missing');
    if (t.listing_complete === false && !basic) problems.push('the submitter has not completed the listing yet');
    if (problems.length) return go(reply, `/admin/tools/${id}`, `Cannot publish yet: ${problems.join('; ')}.`, true);
    await q("update tools set status = 'published', published_at = coalesce(published_at, now()), reject_reason = null, review_note = null, updated_at = now() where id = $1", [id]);
    await enqueueDeploy(`approved ${t.slug}`);
    return go(reply, `/admin?tab=queue`, `${t.name} approved. It goes live within a few minutes${t.submitter_email ? ' and the submitter is emailed once it is up' : ''}.`);
  });

  app.post('/admin/tools/:id/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await getTool(id);
    if (!t) return reply.code(404).send('Not found');
    const note = clean(str(req.body as Body, 'note'), 2000);
    if (note.length < 5) return go(reply, `/admin/tools/${id}`, 'Write the note the submitter should read.', true);
    await q("update tools set status = 'changes_requested', review_note = $2, updated_at = now() where id = $1", [id, note]);
    if (t.submitter_email) await enqueueEmail(templates.toolChangesRequested({ to: t.submitter_email, name: t.submitter_name ?? '', toolName: t.name, note, token: t.edit_token }));
    return go(reply, '/admin?tab=queue', `Change request sent for ${t.name}.`);
  });

  app.post('/admin/tools/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await getTool(id);
    if (!t) return reply.code(404).send('Not found');
    const reason = clean(str(req.body as Body, 'reason'), 1000) || 'it does not fit the directory at the moment';
    const wasLive = t.status === 'published';
    await q("update tools set status = 'rejected', reject_reason = $2, updated_at = now() where id = $1", [id, reason]);
    if (t.submitter_email) await enqueueEmail(templates.toolRejected({ to: t.submitter_email, name: t.submitter_name ?? '', toolName: t.name, reason }));
    if (wasLive) await enqueueDeploy(`unpublished ${t.slug}`);
    return go(reply, '/admin?tab=queue', `${t.name} ${wasLive ? 'unpublished' : 'rejected'}.`);
  });

  app.post('/admin/tools/:id/featured', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await getTool(id);
    if (!t) return reply.code(404).send('Not found');
    if (str(req.body as Body, 'action') === 'revoke') await revokeFeatured(id);
    else await grantFeatured(id, config.featuredTermDays);
    if (t.status === 'published') await enqueueDeploy(`featured changed ${t.slug}`);
    return go(reply, `/admin/tools/${id}`, 'Featured status updated.');
  });

  app.post('/admin/tools/:id/delete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await getTool(id);
    if (!t) return reply.code(404).send('Not found');
    await q('delete from tools where id = $1', [id]);
    if (t.status === 'published') await enqueueDeploy(`deleted ${t.slug}`);
    return go(reply, '/admin?tab=queue', `${t.name} deleted.`);
  });

  // ======================= COMPARISONS =======================
  app.post('/admin/comparisons/new', async (req, reply) => {
    const b = req.body as Body;
    const a = cleanLine(str(b, 'tool_a'), 60).toLowerCase();
    const c = cleanLine(str(b, 'tool_b'), 60).toLowerCase();
    if (!a || !c || a === c) return go(reply, '/admin?tab=comparisons', 'Two different slugs are required.', true);
    const found = (await q<{ slug: string; vertical: string }>('select slug, vertical from tools where slug = any($1)', [[a, c]])).rows;
    if (found.length !== 2) return go(reply, '/admin?tab=comparisons', `Unknown slug: ${found.find((r) => r.slug === a) ? c : a}.`, true);
    if (found[0].vertical !== found[1].vertical) return go(reply, '/admin?tab=comparisons', 'Both tools must be in the same vertical for a compare page to exist.', true);
    const row = await upsertComparison(a, c, { verdict_md: '', pick_a_if: [], pick_b_if: [], winner: null, winner_reason: null, status: 'draft', reviewed_at: null });
    return go(reply, `/admin/comparisons/${row.id}`);
  });

  app.get('/admin/comparisons/:id', async (req, reply) => {
    const c = await getComparison((req.params as { id: string }).id);
    if (!c) return reply.code(404).send('Not found');
    const names = await toolNames([c.tool_a, c.tool_b]);
    reply.type('text/html');
    return layout(`${names.get(c.tool_a) ?? c.tool_a} vs ${names.get(c.tool_b) ?? c.tool_b}`, comparisonPage(c, names), { tab: 'comparisons', ...flashOf(req) });
  });

  app.post('/admin/comparisons/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await getComparison(id);
    if (!c) return reply.code(404).send('Not found');
    const b = req.body as Body;
    const action = str(b, 'action');
    if (action === 'delete') {
      await q('delete from comparisons where id::text = $1', [id]);
      await enqueueDeploy(`comparison removed ${c.tool_a} vs ${c.tool_b}`);
      return go(reply, '/admin?tab=comparisons', 'Verdict deleted. The page falls back to the data-driven version.');
    }
    const verdict = String(b['verdict_md'] ?? '').replace(/\r\n?/g, '\n').trim();
    const status = action === 'publish' ? 'published' : action === 'unpublish' ? 'draft' : c.status;
    if (status === 'published' && verdict.split(/\s+/).filter(Boolean).length < 80) return go(reply, `/admin/comparisons/${id}`, 'A published verdict needs at least 80 words.', true);
    const winner = str(b, 'winner') || null;
    await upsertComparison(c.tool_a, c.tool_b, {
      verdict_md: verdict, pick_a_if: lines(str(b, 'pick_a_if'), 4, 120), pick_b_if: lines(str(b, 'pick_b_if'), 4, 120),
      winner, winner_reason: winner ? cleanLine(str(b, 'winner_reason'), 200) || null : null, status,
      reviewed_at: action === 'publish' || str(b, 'reviewed_today') ? dateOnly(new Date()) : c.reviewed_at ? dateOnly(c.reviewed_at) : null,
    });
    if (status === 'published' || c.status === 'published') await enqueueDeploy(`comparison ${c.tool_a} vs ${c.tool_b}`);
    return go(reply, `/admin/comparisons/${id}`, status === 'published' ? 'Published. Rebuild queued.' : 'Saved as draft.');
  });

  // ======================= ARTICLES =======================
  app.post('/admin/posts/new', async (_req, reply) => {
    const slug = await uniqueSlug(`draft-${Date.now().toString(36)}`, 'posts');
    const { rows } = await q<{ id: string }>("insert into posts (slug, title, kind, status, author) values ($1, 'Untitled article', 'editorial', 'pending', $2) returning id", [slug, `${config.siteName} Editorial`]);
    return go(reply, `/admin/posts/${rows[0].id}`, 'Draft created. Fill it in and approve when ready.');
  });

  app.get('/admin/posts/:id', async (req, reply) => {
    const p = await getPost((req.params as { id: string }).id);
    if (!p) return reply.code(404).send('Not found');
    const order = p.order_id ? (await q<any>('select * from orders where id = $1', [p.order_id])).rows[0] : null;
    reply.type('text/html');
    return layout(p.title, postPage(p, order), { tab: REVIEW.includes(p.status) ? 'queue' : 'articles', ...flashOf(req) });
  });

  app.post('/admin/posts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Body;
    const p = await getPost(id);
    if (!p) return reply.code(404).send('Not found');
    const kind = ['editorial', 'sponsored', 'guest'].includes(str(b, 'kind')) ? str(b, 'kind') : p.kind;
    const pubDate = str(b, 'pub_date') ? new Date(str(b, 'pub_date')) : p.pub_date;
    await q(
      `update posts set slug=$2, title=$3, description=$4, author=$5, author_bio=$6, tags=$7, kind=$8, body_md=$9, notes=$10, pub_date=$11, updated_date=case when status='published' then now() else updated_date end, updated_at=now() where id=$1`,
      [id, cleanLine(str(b, 'slug'), 80).toLowerCase().replace(/[^a-z0-9-]/g, '-') || p.slug, cleanLine(str(b, 'title'), 160) || p.title, cleanLine(str(b, 'description'), 200),
        cleanLine(str(b, 'author'), 100) || p.author, clean(str(b, 'author_bio'), 600) || null, parseTags(str(b, 'tags')), kind,
        String(b['body_md'] ?? '').replace(/\r\n?/g, '\n'), clean(str(b, 'notes'), 2000) || null, isNaN(pubDate.getTime()) ? p.pub_date : pubDate],
    );
    if (p.status === 'published') await enqueueDeploy(`edited post ${p.slug}`);
    return go(reply, `/admin/posts/${id}`, p.status === 'published' ? 'Saved. Rebuild queued.' : 'Saved.');
  });

  app.post('/admin/posts/:id/thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = await getPost(id);
    const file = (req.body as Body)['thumbnail'];
    if (!p || !Buffer.isBuffer(file) || !file.length) return go(reply, `/admin/posts/${id}`, 'No image received.', true);
    try {
      const img = await processPostImage(file);
      const url = await uploadFile(`posts/${p.slug}.${img.ext}`, img.data, img.contentType);
      await q('update posts set thumbnail_url = $2, updated_at = now() where id = $1', [id, url]);
      if (p.status === 'published') await enqueueDeploy(`post image ${p.slug}`);
      return go(reply, `/admin/posts/${id}`, 'Cover image updated.');
    } catch (e) {
      return go(reply, `/admin/posts/${id}`, (e as Error).message, true);
    }
  });

  app.post('/admin/posts/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = await getPost(id);
    if (!p) return reply.code(404).send('Not found');
    const problems: string[] = [];
    if (p.title.length < 5 || p.title === 'Untitled article' || p.title.startsWith('Sponsored article')) problems.push('give it a title');
    if (p.listing_complete === false) problems.push('the author has not added the draft yet');
    if (p.description.length < 20) problems.push('write the summary (20 to 200 characters)');
    if (p.body_md.trim().length < 200) problems.push('the article text is too short');
    if (problems.length) return go(reply, `/admin/posts/${id}`, `Cannot publish yet: ${problems.join('; ')}.`, true);
    await q("update posts set status = 'published', published_at = coalesce(published_at, now()), pub_date = case when published_at is null then now() else pub_date end, reject_reason = null, review_note = null, updated_at = now() where id = $1", [id]);
    await enqueueDeploy(`approved post ${p.slug}`);
    return go(reply, '/admin?tab=articles', `"${p.title}" approved. It goes live within a few minutes${p.submitter_email ? ' and the author is emailed once it is up' : ''}.`);
  });

  app.post('/admin/posts/:id/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = await getPost(id);
    if (!p) return reply.code(404).send('Not found');
    const note = clean(str(req.body as Body, 'note'), 2000);
    if (note.length < 5) return go(reply, `/admin/posts/${id}`, 'Write the note the author should read.', true);
    await q("update posts set status = 'changes_requested', review_note = $2, updated_at = now() where id = $1", [id, note]);
    if (p.submitter_email) await enqueueEmail(templates.articleChangesRequested({ to: p.submitter_email, name: p.submitter_name ?? '', title: p.title, note, token: p.edit_token }));
    return go(reply, '/admin?tab=queue', `Change request sent for "${p.title}".`);
  });

  app.post('/admin/posts/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = await getPost(id);
    if (!p) return reply.code(404).send('Not found');
    const reason = clean(str(req.body as Body, 'reason'), 1000) || 'it does not fit the site at the moment';
    const wasLive = p.status === 'published';
    await q("update posts set status = 'rejected', reject_reason = $2, updated_at = now() where id = $1", [id, reason]);
    if (p.submitter_email) await enqueueEmail(templates.articleRejected({ to: p.submitter_email, name: p.submitter_name ?? '', title: p.title, reason }));
    if (wasLive) await enqueueDeploy(`unpublished post ${p.slug}`);
    return go(reply, '/admin?tab=articles', `"${p.title}" ${wasLive ? 'unpublished' : 'rejected'}.`);
  });

  app.post('/admin/posts/:id/delete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = await getPost(id);
    if (!p) return reply.code(404).send('Not found');
    await q('delete from posts where id = $1', [id]);
    if (p.status === 'published') await enqueueDeploy(`deleted post ${p.slug}`);
    return go(reply, '/admin?tab=articles', `"${p.title}" deleted.`);
  });
}

// ---------------- rendering ----------------
function toolsTable(rows: ToolRow[]): string {
  return `<table><tr><th></th><th>Tool</th><th>Category</th><th>Status</th><th>Plan</th><th>Updated</th><th></th></tr>${rows.map((t) => `<tr>
    <td style="width:72px">${t.thumbnail_url ? `<img src="${esc(t.thumbnail_url)}" alt="" style="width:64px;aspect-ratio:1200/534;object-fit:cover;border-radius:6px">` : '<span class="pill grey">no image</span>'}</td>
    <td><a href="/admin/tools/${t.id}"><strong>${esc(t.name)}</strong></a><br><span class="meta">${esc(t.tagline)}</span></td>
    <td>${esc(getVertical(t.vertical)?.short ?? t.vertical)} / ${esc(t.category)}${t.category === OTHER_CATEGORY ? ' <span class="pill warn">fix</span>' : ''}</td>
    <td>${statusPill(t.status)}${t.listing_complete === false ? ' <span class="pill warn" title="Paid first; the submitter has not added the description yet">incomplete</span>' : ''}</td><td>${planPill(t)}</td>
    <td class="meta">${fmtDate(t.updated_at)}<br>${esc(t.submitter_email ?? 'editorial')}</td>
    <td><a class="btn ghost sm" href="/admin/tools/${t.id}">Open</a></td></tr>`).join('')}</table>`;
}

function postsTable(rows: (PostRow & { order_status?: string | null })[]): string {
  return `<table><tr><th></th><th>Article</th><th>Kind</th><th>Status</th><th>Payment</th><th>Updated</th><th></th></tr>${rows.map((p) => `<tr>
    <td style="width:72px">${p.thumbnail_url ? `<img src="${esc(p.thumbnail_url)}" alt="" style="width:64px;aspect-ratio:16/9;object-fit:cover;border-radius:6px">` : '<span class="pill grey">no image</span>'}</td>
    <td><a href="/admin/posts/${p.id}"><strong>${esc(p.title)}</strong></a><br><span class="meta">${esc(p.author)}${p.company ? ` · ${esc(p.company)}` : ''}</span></td>
    <td><span class="pill grey">${esc(p.kind)}</span>${p.written_by_us ? ' <span class="pill warn">we write it</span>' : ''}</td>
    <td>${statusPill(p.status)}${p.listing_complete === false ? ' <span class="pill warn" title="Paid first; the author has not added the draft yet">no draft yet</span>' : ''}</td>
    <td>${p.kind === 'sponsored' ? (p.order_status ? statusPill(p.order_status) : '<span class="pill grey">no order</span>') : '<span class="meta">n/a</span>'}</td>
    <td class="meta">${fmtDate(p.updated_at)}<br>${esc(p.submitter_email ?? 'editorial')}</td>
    <td><a class="btn ghost sm" href="/admin/posts/${p.id}">Open</a></td></tr>`).join('')}</table>`;
}

function planPill(t: ToolRow): string {
  if (isFeatured(t)) return `<span class="pill">Featured until ${fmtDate(t.paid_until)}</span>`;
  if (t.plan === 'featured') return `<span class="pill warn">Featured requested, unpaid</span>`;
  return `<span class="pill grey">Basic</span>`;
}

const promptForm = (action: string, field: string, label: string, cls: string, question: string, confirmText?: string) =>
  `<form method="post" action="${action}" ${confirmText ? `onsubmit="return confirm('${esc(confirmText)}')"` : ''}><input type="hidden" name="${field}" id="${field}-${action.replace(/\W/g, '')}"><button class="btn ${cls}" type="submit" onclick="const v = prompt(${esc(JSON.stringify(question))}, ''); if (v === null) return false; document.getElementById('${field}-${action.replace(/\W/g, '')}').value = v;">${label}</button></form>`;

function submitterBox(kind: 'tool' | 'post', row: { submitter_name: string | null; submitter_email: string | null; edit_token: string | null; review_note: string | null; notes: string | null }): string {
  return `<div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Submitter</h2>
    <dl class="kv"><dt>Name</dt><dd>${esc(row.submitter_name ?? '')}</dd><dt>Email</dt><dd>${row.submitter_email ? `<a href="mailto:${esc(row.submitter_email)}">${esc(row.submitter_email)}</a>` : '<span class="muted">editorial</span>'}</dd>
    ${row.edit_token ? `<dt>Their edit link</dt><dd><a href="/s/${esc(row.edit_token)}" target="_blank" rel="noopener">/s/${esc(row.edit_token).slice(0, 10)}…</a></dd>` : ''}
    ${row.review_note ? `<dt>Open change request</dt><dd>${esc(row.review_note)}</dd>` : ''}
    ${row.notes ? `<dt>${kind === 'tool' ? 'Their notes' : 'Notes'}</dt><dd>${esc(row.notes)}</dd>` : ''}</dl></div>`;
}

function toolPage(t: ToolRow, orders: any[]): string {
  const v = getVertical(t.vertical);
  const cats = [...(v?.categories ?? []), OTHER_CATEGORY];
  const taxonomy = JSON.stringify(Object.fromEntries(VERTICALS.map((x) => [x.slug, x.categories])));
  const html = renderMarkdown(t.body_md);
  const initial = esc(t.name.charAt(0).toUpperCase());
  const live = t.status === 'published';
  return `
  <p class="meta"><a href="/admin?tab=${REVIEW.includes(t.status) ? 'queue' : t.status}">Back</a></p>
  <div class="row" style="justify-content:space-between;margin-bottom:1rem"><h1 style="margin:0">${esc(t.name)} ${statusPill(t.status)} ${planPill(t)}</h1>
    <div class="row">
      ${!live ? `<form method="post" action="/admin/tools/${t.id}/approve"><button class="btn" type="submit">Approve and publish</button></form>` : `<a class="btn ghost" href="${esc(config.siteUrl)}/tools/${esc(t.slug)}/" target="_blank" rel="noopener">View live</a>`}
      ${t.submitter_email && !live ? promptForm(`/admin/tools/${t.id}/changes`, 'note', 'Request changes', 'ghost', 'What should the submitter change? They receive this text by email.') : ''}
      ${promptForm(`/admin/tools/${t.id}/reject`, 'reason', live ? 'Unpublish' : 'Reject', 'danger', 'Reason (the submitter reads this):', live ? 'Unpublish this listing?' : 'Reject this listing?')}
    </div></div>
  ${t.reject_reason ? `<div class="flash err">Rejected: ${esc(t.reject_reason)}</div>` : ''}
  ${t.review_note && t.status === 'changes_requested' ? `<div class="notice"><strong>Waiting on the submitter.</strong> ${esc(t.review_note)}</div>` : ''}
  <div class="two">
    <div>
      <form class="stack card" method="post" action="/admin/tools/${t.id}">
        <label>Name <input name="name" value="${esc(t.name)}" required></label>
        <label>Slug <small>/tools/&lt;slug&gt;/ on the site. Changing it after publishing breaks old links.</small><input name="slug" value="${esc(t.slug)}" required></label>
        <label>Website <input name="website" value="${esc(t.website)}" required></label>
        <label>Tagline <small>max 140 characters, shown on the card</small><input name="tagline" value="${esc(t.tagline)}" maxlength="140" required></label>
        <div class="two">
          <label>Category <select name="vertical" id="v-sel">${VERTICALS.map((x) => `<option value="${x.slug}" ${x.slug === t.vertical ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
          <label>Subcategory <select name="category" id="c-sel">${cats.map((c) => `<option ${c === t.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        </div>
        <div class="two">
          <label>Pricing <select name="pricing">${PRICING.map((p) => `<option ${p === t.pricing ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
          <label>Rating <select name="rating"><option value="">none</option>${[1, 2, 3, 3.5, 4, 4.5, 5].map((n) => `<option value="${n}" ${Number(t.rating) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </div>
        <label>Best for <input name="best_for" value="${esc(t.best_for)}"></label>
        <label style="grid-template-columns:auto 1fr;align-items:center;gap:.5rem"><input type="checkbox" name="editors_pick" style="width:auto" ${t.editors_pick ? 'checked' : ''}> Editor's pick (never paid)</label>
        <label>Review body (markdown) <small>Four H2 sections: What is X?, Where it shines, Where it falls short, Conclusion. No tables, no FAQ, no em dashes.</small><textarea name="body_md" rows="22">${esc(t.body_md)}</textarea></label>
        <label>Private notes <textarea name="notes" rows="3">${esc(t.notes ?? '')}</textarea></label>
        <div class="row"><button class="btn" type="submit">Save</button>${live ? '<span class="meta">Saving a live listing queues a rebuild.</span>' : ''}</div>
      </form>
      <form class="stack card" method="post" action="/admin/tools/${t.id}/comparison" id="comparison" style="margin-top:1rem">
        <h2 style="margin-top:0">Comparison data ${t.data_checked_at ? `<span class="pill">checked ${dateOnly(t.data_checked_at)}</span>` : '<span class="pill warn">not checked by a person yet</span>'}</h2>
        ${comparisonFields(t.vertical, t, true)}
        <div class="row"><button class="btn" type="submit" name="action" value="save">Save</button><button class="btn ghost" type="submit" name="action" value="verified">Save and mark as checked today</button><span class="meta">The date shows on the compare and alternatives pages, so only mark it after opening the vendor's pricing page.</span></div>
      </form>
      <div class="card" style="margin-top:1rem">
        <h2 style="margin-top:0">Thumbnail</h2>
        <form method="post" action="/admin/tools/${t.id}/thumbnail" enctype="multipart/form-data" class="row"><input type="file" name="thumbnail" accept="image/png,image/jpeg,image/webp" required style="max-width:20rem"><button class="btn ghost sm" type="submit">Upload</button></form>
        <p class="meta">Resized to 1200 by 534 and converted to WebP automatically.</p>
      </div>
      <div class="card" style="margin-top:1rem">
        <h2 style="margin-top:0">Featured placement</h2>
        <dl class="kv"><dt>Plan</dt><dd>${planPill(t)}</dd></dl>
        ${orders.length ? `<table style="margin:.75rem 0"><tr><th>When</th><th>Amount</th><th>Status</th></tr>${orders.map((o) => `<tr><td>${fmtDate(o.created_at)}</td><td>${money(o.amount_cents, o.currency)}${o.discount_cents ? `<br><span class="meta">bundle discount ${money(o.discount_cents, o.currency)}</span>` : ''}</td><td>${statusPill(o.status)}</td></tr>`).join('')}</table>` : '<p class="meta">No orders for this tool.</p>'}
        <form method="post" action="/admin/tools/${t.id}/featured" class="row">
          <button class="btn ghost sm" name="action" value="grant" type="submit">Grant 12 months (manual payment)</button>
          ${t.plan === 'featured' ? '<button class="btn ghost sm" name="action" value="revoke" type="submit">Revoke featured</button>' : ''}
        </form>
      </div>
      ${submitterBox('tool', t)}
      <form method="post" action="/admin/tools/${t.id}/delete" onsubmit="return confirm('Delete permanently? Prefer Reject unless it is spam.')" style="margin-top:1rem"><button class="btn ghost sm" type="submit">Delete permanently</button></form>
    </div>
    <div>
      <h2 style="margin-top:0">How the card will look</h2>
      <div class="tool-card">${t.thumbnail_url ? `<img src="${esc(t.thumbnail_url)}" alt="">` : `<div class="ph">${initial}</div>`}<div class="in"><div class="row" style="justify-content:space-between"><span class="pill">${esc(t.category)}</span>${isFeatured(t) ? '<span class="pill warn">Featured</span>' : t.editors_pick ? '<span class="pill">Editor\'s pick</span>' : ''}</div><h3>${esc(t.name)}</h3><p class="muted" style="margin:0;font-size:.93rem">${esc(t.tagline)}</p><p style="margin:.4rem 0 0">${stars(t.rating)} <span class="meta">${esc(t.pricing)}</span></p></div></div>
      <h2>How the page will read</h2>
      <div class="card prose"><p class="meta">Tools / ${esc(v?.name ?? t.vertical)} / ${esc(t.category)}</p><h1 style="font-size:1.6rem">${esc(t.name)}</h1><p class="muted">${esc(t.tagline)}</p><dl class="kv"><dt>Pricing</dt><dd>${esc(t.pricing)}</dd><dt>Best for</dt><dd>${esc(t.best_for)}</dd></dl><hr style="border:0;border-top:1px solid var(--border);margin:1rem 0">${html}</div>
    </div>
  </div>
  <script>
    const tax = ${taxonomy}; const other = ${JSON.stringify(OTHER_CATEGORY)}; const feats = ${JSON.stringify(FEATURES)};
    document.getElementById('v-sel').addEventListener('change', (e) => { const c = document.getElementById('c-sel'); c.innerHTML = ''; [...(tax[e.target.value] || []), other].forEach((x) => { const o = document.createElement('option'); o.textContent = x; c.appendChild(o); });
      const f = document.getElementById('feat-box'); f.innerHTML = (feats[e.target.value] || []).map((x) => '<label class="chk"><input type="checkbox" name="key_features" value="' + x.replace(/"/g, '&quot;') + '"> ' + x + '</label>').join(''); });
  </script>`;
}

async function toolNames(slugs: string[]): Promise<Map<string, string>> {
  if (!slugs.length) return new Map();
  const { rows } = await q<{ slug: string; name: string }>('select slug, name from tools where slug = any($1)', [[...new Set(slugs)]]);
  return new Map(rows.map((r) => [r.slug, r.name]));
}

function comparisonPage(c: ComparisonRow, names: Map<string, string>): string {
  const na = names.get(c.tool_a) ?? c.tool_a;
  const nb = names.get(c.tool_b) ?? c.tool_b;
  const html = renderMarkdown(c.verdict_md || '_No verdict written yet._');
  return `
  <p class="meta"><a href="/admin?tab=comparisons">Back</a></p>
  <div class="row" style="justify-content:space-between;margin-bottom:1rem"><h1 style="margin:0">${esc(na)} vs ${esc(nb)} ${statusPill(c.status)}</h1>
    <a class="btn ghost" href="${esc(config.siteUrl)}/tools/compare/${esc(c.tool_a)}-vs-${esc(c.tool_b)}/" target="_blank" rel="noopener">View page</a></div>
  <div class="two">
    <form class="stack card" method="post" action="/admin/comparisons/${c.id}">
      <label>Verdict (markdown) <small>2 to 4 paragraphs: the one-sentence answer and who each is for; the two or three real differences; the trap people fall into; optionally when neither fits. Never mention paid placement or ratings.</small><textarea name="verdict_md" rows="18">${esc(c.verdict_md)}</textarea></label>
      <div class="two"><label>Pick ${esc(na)} if <small>one per line, 3 to 4</small><textarea name="pick_a_if" rows="5">${esc(c.pick_a_if.join('\n'))}</textarea></label>
      <label>Pick ${esc(nb)} if <small>one per line, 3 to 4</small><textarea name="pick_b_if" rows="5">${esc(c.pick_b_if.join('\n'))}</textarea></label></div>
      <div class="two"><label>Winner <small>only when one is clearly the better default for most buyers</small><select name="winner"><option value="">no call</option><option value="${esc(c.tool_a)}" ${c.winner === c.tool_a ? 'selected' : ''}>${esc(na)}</option><option value="${esc(c.tool_b)}" ${c.winner === c.tool_b ? 'selected' : ''}>${esc(nb)}</option></select></label>
      <label>Why <small>one sentence, shown next to the winner</small><input name="winner_reason" value="${esc(c.winner_reason ?? '')}" maxlength="200"></label></div>
      <label class="chk"><input type="checkbox" name="reviewed_today" value="1"> Mark as reviewed today${c.reviewed_at ? ` (last: ${dateOnly(c.reviewed_at)})` : ''}</label>
      <div class="row"><button class="btn ghost" type="submit" name="action" value="save">Save draft</button>
        ${c.status === 'published' ? '<button class="btn ghost" type="submit" name="action" value="unpublish">Save and unpublish</button>' : ''}
        <button class="btn" type="submit" name="action" value="publish">Save and publish</button>
        <button class="btn danger sm" type="submit" name="action" value="delete" onclick="return confirm('Delete this verdict? The page keeps working with the data-driven version.')" style="margin-left:auto">Delete</button></div>
    </form>
    <div><h2 style="margin-top:0">Preview</h2><div class="card prose">${html}
      ${c.pick_a_if.length ? `<h3>Pick ${esc(na)} if</h3><ul>${c.pick_a_if.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${c.pick_b_if.length ? `<h3>Pick ${esc(nb)} if</h3><ul>${c.pick_b_if.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${c.winner ? `<p><strong>Our call: ${esc(names.get(c.winner) ?? c.winner)}.</strong> ${esc(c.winner_reason ?? '')}</p>` : ''}</div></div>
  </div>`;
}

function postPage(p: PostRow, order: any): string {
  const html = renderMarkdown(p.body_md);
  const live = p.status === 'published';
  const date = new Date(p.pub_date).toISOString().slice(0, 10);
  return `
  <p class="meta"><a href="/admin?tab=${REVIEW.includes(p.status) ? 'queue' : 'articles'}">Back</a></p>
  <div class="row" style="justify-content:space-between;margin-bottom:1rem"><h1 style="margin:0">${esc(p.title)} ${statusPill(p.status)} <span class="pill grey">${esc(p.kind)}</span></h1>
    <div class="row">
      ${!live ? `<form method="post" action="/admin/posts/${p.id}/approve"><button class="btn" type="submit">Approve and publish</button></form>` : `<a class="btn ghost" href="${esc(config.siteUrl)}/blog/${esc(p.slug)}/" target="_blank" rel="noopener">View live</a>`}
      ${p.submitter_email && !live ? promptForm(`/admin/posts/${p.id}/changes`, 'note', 'Request changes', 'ghost', 'What should the author change? They receive this text by email.') : ''}
      ${promptForm(`/admin/posts/${p.id}/reject`, 'reason', live ? 'Unpublish' : 'Reject', 'danger', 'Reason (the author reads this):', live ? 'Unpublish this article?' : 'Reject this article?')}
    </div></div>
  ${p.kind === 'sponsored' ? `<div class="${order?.status === 'paid' ? 'flash' : 'notice'}">Sponsored article · payment ${order ? statusPill(order.status) : '<span class="pill grey">no order</span>'}${order ? ` · ${money(order.amount_cents, order.currency)}` : ''}${p.written_by_us ? ' · <strong>we write it</strong> from their pitch below' : ''}</div>` : ''}
  ${p.reject_reason ? `<div class="flash err">Rejected: ${esc(p.reject_reason)}</div>` : ''}
  ${p.review_note && p.status === 'changes_requested' ? `<div class="notice"><strong>Waiting on the author.</strong> ${esc(p.review_note)}</div>` : ''}
  <div class="two">
    <div>
      <form class="stack card" method="post" action="/admin/posts/${p.id}">
        <label>Title <input name="title" value="${esc(p.title)}" maxlength="160" required></label>
        <label>Slug <small>/blog/&lt;slug&gt;/ on the site</small><input name="slug" value="${esc(p.slug)}" required></label>
        <label>Summary <small>20 to 200 characters. Shown in listings, search results and social previews.</small><input name="description" value="${esc(p.description)}" maxlength="200"></label>
        <div class="two"><label>Author <input name="author" value="${esc(p.author)}"></label><label>Kind <select name="kind">${['editorial', 'sponsored', 'guest'].map((k) => `<option ${k === p.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label></div>
        <label>Author bio <small>one or two sentences, shown at the end of the post</small><input name="author_bio" value="${esc(p.author_bio ?? '')}"></label>
        <div class="two"><label>Tags <small>comma separated</small><input name="tags" value="${esc(p.tags.join(', '))}"></label><label>Publish date <input type="date" name="pub_date" value="${date}"></label></div>
        <label>Article (markdown) <small>Headings with ##. Sponsored posts: up to 2 links to the sponsor, the disclosure box is added by the site automatically.</small><textarea name="body_md" rows="28">${esc(p.body_md)}</textarea></label>
        <label>Private notes <textarea name="notes" rows="3">${esc(p.notes ?? '')}</textarea></label>
        <div class="row"><button class="btn" type="submit">Save</button>${live ? '<span class="meta">Saving a live article queues a rebuild.</span>' : ''}</div>
      </form>
      <div class="card" style="margin-top:1rem">
        <h2 style="margin-top:0">Cover image</h2>
        <form method="post" action="/admin/posts/${p.id}/thumbnail" enctype="multipart/form-data" class="row"><input type="file" name="thumbnail" accept="image/png,image/jpeg,image/webp" required style="max-width:20rem"><button class="btn ghost sm" type="submit">Upload</button></form>
        <p class="meta">16:9 works best (1200 by 675). Converted to WebP, max 1600 wide.</p>
      </div>
      ${submitterBox('post', p)}
      ${p.website ? `<p class="meta" style="margin-top:.75rem">Sponsor site: <a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website)}</a></p>` : ''}
      <form method="post" action="/admin/posts/${p.id}/delete" onsubmit="return confirm('Delete permanently?')" style="margin-top:1rem"><button class="btn ghost sm" type="submit">Delete permanently</button></form>
    </div>
    <div>
      <h2 style="margin-top:0">How the card will look</h2>
      <div class="post-card">${p.thumbnail_url ? `<img src="${esc(p.thumbnail_url)}" alt="">` : '<div style="aspect-ratio:16/9;background:#eef1ef"></div>'}<div class="in"><p class="meta" style="margin:0 0 .3rem">${fmtDate(p.pub_date)}${p.kind === 'sponsored' ? ' · <span class="pill warn">Sponsored</span>' : ''}</p><h3 style="margin:0">${esc(p.title)}</h3><p class="meta" style="margin:.4rem 0 0">${p.tags.map((t) => `<span class="pill" style="margin-right:.3rem">${esc(t)}</span>`).join('')}</p></div></div>
      <h2>How the page will read</h2>
      <div class="card prose"><p class="meta">Blog · ${fmtDate(p.pub_date)} · ${esc(p.author)}</p><h1 style="font-size:1.6rem">${esc(p.title)}</h1><p class="muted">${esc(p.description)}</p>${p.kind === 'sponsored' ? '<div class="notice"><strong>Sponsored content.</strong> This article was paid for by the company featured in it.</div>' : ''}${html}${p.author_bio ? `<div class="notice"><strong>About the author.</strong> ${esc(p.author_bio)}</div>` : ''}</div>
    </div>
  </div>`;
}
