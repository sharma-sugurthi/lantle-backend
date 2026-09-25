import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { marked } from 'marked';
import { config } from '../config.js';
import { q } from '../db.js';
import { templates } from '../lib/email.js';
import { layout, stars, statusPill } from '../lib/html.js';
import { processThumbnail, uploadThumbnail } from '../lib/storage.js';
import { clean, cleanLine, esc, fmtDate, money } from '../lib/text.js';
import { getTool, grantFeatured, isFeatured, revokeFeatured, type ToolRow } from '../lib/tools.js';
import { OTHER_CATEGORY, PRICING, VERTICALS, getVertical, isValidCategory } from '../taxonomy.js';
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

export default async function adminRoutes(app: FastifyInstance) {
  // ---- auth ----
  app.get('/admin/login', async (req, reply) => {
    reply.type('text/html');
    return layout('Log in', `<div class="card" style="max-width:24rem;margin:3rem auto"><h1>Log in</h1>
      <form class="stack" method="post" action="/admin/login"><label>Password <input type="password" name="password" autofocus required /></label><button class="btn" type="submit">Log in</button></form></div>`, { nav: false, ...flashOf(req) });
  });

  app.post('/admin/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const given = Buffer.from(str(req.body as Body, 'password'));
    const want = Buffer.from(config.admin.password);
    const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) return go(reply, '/admin/login', 'Wrong password.', true);
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
    const tab = (req.query as Record<string, string>).tab || 'queue';
    reply.type('text/html');
    let body = '';
    if (tab === 'queue' || tab === 'published' || tab === 'rejected') {
      const status = tab === 'queue' ? 'pending' : tab;
      const { rows } = await q<ToolRow>(`select * from tools where status = $1 order by ${tab === 'published' ? 'published_at desc nulls last' : 'added_at desc'} limit 500`, [status]);
      body = `<div class="row" style="justify-content:space-between"><h1>${tab === 'queue' ? 'Review queue' : tab[0].toUpperCase() + tab.slice(1)} <span class="pill grey">${rows.length}</span></h1>
        <form method="post" action="/admin/deploy"><button class="btn ghost sm" type="submit">Rebuild site now</button></form></div>
        ${rows.length ? toolsTable(rows) : '<p class="muted">Nothing here.</p>'}`;
    } else if (tab === 'orders') {
      const orders = (await q<any>('select o.*, t.name as tool_name, t.slug from orders o left join tools t on t.id = o.tool_id order by o.created_at desc limit 300')).rows;
      const articles = (await q<any>('select * from articles order by created_at desc limit 200')).rows;
      body = `<h1>Orders</h1>${orders.length ? `<table><tr><th>When</th><th>What</th><th>Customer</th><th>Amount</th><th>Status</th><th>Ref</th></tr>${orders.map((o: any) => `<tr><td>${fmtDate(o.created_at)}</td><td>${esc(describe(o))}${o.tool_name ? `<br><a href="/admin/tools/${o.tool_id}">${esc(o.tool_name)}</a>` : ''}</td><td>${esc(o.name ?? '')}<br><span class="meta">${esc(o.email ?? '')}</span></td><td>${money(o.amount_cents, o.currency)}</td><td>${statusPill(o.status)}</td><td class="meta">${esc(o.provider_payment_id ?? o.provider_session_id ?? '')}<br>${esc(o.id)}</td></tr>`).join('')}</table>` : '<p class="muted">No orders yet.</p>'}
        <h2>Sponsored article submissions</h2>${articles.length ? articles.map((a: any) => `<div class="card" style="margin-bottom:1rem"><div class="row" style="justify-content:space-between"><strong>${esc(a.title)}</strong>${statusPill(a.status)}</div><p class="meta">${esc(a.company)} · ${esc(a.email)} · ${a.written_by_us ? 'wants us to write it (+$19)' : 'supplies the draft'} · ${fmtDate(a.created_at)}${a.author_name ? ` · by ${esc(a.author_name)}` : ''}</p><pre>${esc(a.draft)}</pre><p class="meta">Publishing an article is still a markdown file in <code>src/content/blog/</code> with <code>sponsored: true</code>. Copy the draft from here.</p></div>`).join('') : '<p class="muted">None yet.</p>'}`;
    } else if (tab === 'messages') {
      const { rows } = await q<any>('select * from messages order by created_at desc limit 300');
      body = `<h1>Messages</h1>${rows.length ? rows.map((m: any) => `<div class="card" id="m-${m.id}" style="margin-bottom:1rem"><div class="row" style="justify-content:space-between"><strong>${esc(m.name || m.email)}</strong><span class="pill grey">${esc(m.kind.replace('_', ' '))}</span></div><p class="meta"><a href="mailto:${esc(m.email)}">${esc(m.email)}</a>${m.company ? ` · ${esc(m.company)}` : ''}${m.interest ? ` · ${esc(m.interest)}` : ''} · ${fmtDate(m.created_at)}</p><pre>${esc(m.message)}</pre></div>`).join('') : '<p class="muted">No messages yet.</p>'}`;
    } else if (tab === 'subscribers') {
      const { rows } = await q<any>('select * from subscribers where unsubscribed_at is null order by created_at desc');
      body = `<h1>Subscribers <span class="pill grey">${rows.length}</span></h1><p class="meta">Copy the list into your newsletter tool when you send.</p><pre>${rows.map((s: any) => esc(s.email)).join('\n')}</pre>`;
    } else if (tab === 'jobs') {
      const failed = (await q<any>("select id, name, data, output, retry_count, created_on, completed_on from pgboss.job where state = 'failed' order by created_on desc limit 100")).rows;
      const recent = (await q<any>("select name, state, count(*)::int as n from pgboss.job where created_on > now() - interval '7 days' group by name, state order by name, state")).rows;
      body = `<h1>Background jobs</h1><h2>Last 7 days</h2><table><tr><th>Queue</th><th>State</th><th>Count</th></tr>${recent.map((r: any) => `<tr><td>${esc(r.name)}</td><td>${statusPill(r.state)}</td><td>${r.n}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No jobs yet.</td></tr>'}</table>
        <h2>Failed</h2>${failed.length ? failed.map((j: any) => `<div class="card" style="margin-bottom:1rem"><div class="row" style="justify-content:space-between"><strong>${esc(j.name)}</strong><form method="post" action="/admin/jobs/retry"><input type="hidden" name="name" value="${esc(j.name)}"><input type="hidden" name="data" value="${esc(JSON.stringify(j.data))}"><button class="btn sm" type="submit">Retry</button></form></div><p class="meta">${fmtDate(j.created_on)} · ${j.retry_count} retries</p><pre>${esc(JSON.stringify(j.output ?? {}, null, 1)).slice(0, 1200)}</pre><pre>${esc(JSON.stringify(j.data)).slice(0, 600)}</pre></div>`).join('') : '<p class="muted">Nothing failed.</p>'}`;
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

  // ---- tool detail ----
  app.get('/admin/tools/:id', async (req, reply) => {
    const t = await getTool((req.params as { id: string }).id);
    if (!t) return reply.code(404).send('Not found');
    const orders = (await q<any>('select * from orders where tool_id = $1 order by created_at desc', [t.id])).rows;
    reply.type('text/html');
    return layout(t.name, toolPage(t, orders), { tab: t.status === 'pending' ? 'queue' : t.status, ...flashOf(req) });
  });

  app.post('/admin/tools/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Body;
    const vertical = cleanLine(str(b, 'vertical'), 40);
    const category = cleanLine(str(b, 'category'), 60);
    if (!getVertical(vertical)) return go(reply, `/admin/tools/${id}`, 'Unknown category.', true);
    const rating = Number(str(b, 'rating')) || null;
    const ratingOk = rating !== null && rating >= 1 && rating <= 5 && Number.isInteger(rating * 2);
    await q(
      `update tools set name=$2, website=$3, tagline=$4, vertical=$5, category=$6, pricing=$7, best_for=$8, rating=$9, editors_pick=$10, body_md=$11, notes=$12, slug=$13, updated_at=now() where id=$1`,
      [id, cleanLine(str(b, 'name'), 80), cleanLine(str(b, 'website'), 300), cleanLine(str(b, 'tagline'), 140), vertical, category,
        (PRICING as readonly string[]).includes(str(b, 'pricing')) ? str(b, 'pricing') : 'Paid', cleanLine(str(b, 'best_for'), 120),
        ratingOk ? rating : null, str(b, 'editors_pick') !== '', String(b['body_md'] ?? '').replace(/\r\n?/g, '\n'), clean(str(b, 'notes'), 2000) || null,
        cleanLine(str(b, 'slug'), 60).toLowerCase().replace(/[^a-z0-9-]/g, '-')],
    ).catch((e) => { throw e; });
    const t = await getTool(id);
    if (t?.status === 'published') await enqueueDeploy(`edited ${t.slug}`);
    return go(reply, `/admin/tools/${id}`, t?.status === 'published' ? 'Saved. Rebuild queued.' : 'Saved.');
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
    if (t.body_md.trim().length < 100) problems.push('the review body is too short');
    if (t.tagline.length < 10) problems.push('the tagline is missing');
    if (problems.length) return go(reply, `/admin/tools/${id}`, `Cannot publish yet: ${problems.join('; ')}.`, true);
    await q("update tools set status = 'published', published_at = coalesce(published_at, now()), reject_reason = null, updated_at = now() where id = $1", [id]);
    await enqueueDeploy(`approved ${t.slug}`);
    return go(reply, `/admin?tab=queue`, `${t.name} approved. It goes live within a few minutes${t.submitter_email ? ' and the submitter is emailed once it is up' : ''}.`);
  });

  app.post('/admin/tools/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await getTool(id);
    if (!t) return reply.code(404).send('Not found');
    const reason = clean(str(req.body as Body, 'reason'), 1000) || 'it does not fit the directory at the moment';
    const wasLive = t.status === 'published';
    await q("update tools set status = 'rejected', reject_reason = $2, updated_at = now() where id = $1", [id, reason]);
    if (t.submitter_email) await enqueueEmail(templates.rejected({ to: t.submitter_email, name: t.submitter_name ?? '', toolName: t.name, reason }));
    if (wasLive) await enqueueDeploy(`unpublished ${t.slug}`);
    return go(reply, '/admin?tab=queue', `${t.name} rejected.`);
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
}

function toolsTable(rows: ToolRow[]): string {
  return `<table><tr><th></th><th>Tool</th><th>Category</th><th>Plan</th><th>Submitted</th><th></th></tr>${rows.map((t) => `<tr>
    <td style="width:72px">${t.thumbnail_url ? `<img src="${esc(t.thumbnail_url)}" alt="" style="width:64px;aspect-ratio:1200/534;object-fit:cover;border-radius:6px">` : '<span class="pill grey">no image</span>'}</td>
    <td><a href="/admin/tools/${t.id}"><strong>${esc(t.name)}</strong></a><br><span class="meta">${esc(t.tagline)}</span></td>
    <td>${esc(getVertical(t.vertical)?.short ?? t.vertical)} / ${esc(t.category)}${t.category === OTHER_CATEGORY ? ' <span class="pill warn">fix</span>' : ''}</td>
    <td>${planPill(t)}</td>
    <td class="meta">${fmtDate(t.added_at)}<br>${esc(t.submitter_email ?? 'editorial')}</td>
    <td><a class="btn ghost sm" href="/admin/tools/${t.id}">Open</a></td></tr>`).join('')}</table>`;
}

function planPill(t: ToolRow): string {
  if (isFeatured(t)) return `<span class="pill">Featured until ${fmtDate(t.paid_until)}</span>`;
  if (t.plan === 'featured') return `<span class="pill warn">Featured requested, unpaid</span>`;
  return `<span class="pill grey">Basic</span>`;
}

function toolPage(t: ToolRow, orders: any[]): string {
  const v = getVertical(t.vertical);
  const cats = [...(v?.categories ?? []), OTHER_CATEGORY];
  const taxonomy = JSON.stringify(Object.fromEntries(VERTICALS.map((x) => [x.slug, x.categories])));
  const html = marked.parse(t.body_md) as string;
  const initial = esc(t.name.charAt(0).toUpperCase());
  return `
  <p class="meta"><a href="/admin?tab=${t.status === 'pending' ? 'queue' : t.status}">Back</a></p>
  <div class="row" style="justify-content:space-between;margin-bottom:1rem"><h1 style="margin:0">${esc(t.name)} ${statusPill(t.status)} ${planPill(t)}</h1>
    <div class="row">
      ${t.status !== 'published' ? `<form method="post" action="/admin/tools/${t.id}/approve"><button class="btn" type="submit">Approve and publish</button></form>` : `<a class="btn ghost" href="${esc(config.siteUrl)}/tools/${esc(t.slug)}/" target="_blank" rel="noopener">View live</a>`}
      <form method="post" action="/admin/tools/${t.id}/reject" onsubmit="return confirm('Reject this listing?')"><input type="hidden" name="reason" id="reason-field"><button class="btn danger" type="submit" onclick="document.getElementById('reason-field').value = prompt('Reason (the submitter reads this):','') || ''">${t.status === 'published' ? 'Unpublish' : 'Reject'}</button></form>
    </div></div>
  ${t.reject_reason ? `<div class="flash err">Rejected: ${esc(t.reject_reason)}</div>` : ''}
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
        <div class="row"><button class="btn" type="submit">Save</button>${t.status === 'published' ? '<span class="meta">Saving a live listing queues a rebuild.</span>' : ''}</div>
      </form>
      <div class="card" style="margin-top:1rem">
        <h2 style="margin-top:0">Thumbnail</h2>
        <form method="post" action="/admin/tools/${t.id}/thumbnail" enctype="multipart/form-data" class="row"><input type="file" name="thumbnail" accept="image/png,image/jpeg,image/webp" required style="max-width:20rem"><button class="btn ghost sm" type="submit">Upload</button></form>
        <p class="meta">Resized to 1200 by 534 and converted to WebP automatically.</p>
      </div>
      <div class="card" style="margin-top:1rem">
        <h2 style="margin-top:0">Featured placement</h2>
        <dl class="kv"><dt>Plan</dt><dd>${planPill(t)}</dd><dt>Submitter</dt><dd>${esc(t.submitter_name ?? '')} ${t.submitter_email ? `<a href="mailto:${esc(t.submitter_email)}">${esc(t.submitter_email)}</a>` : '<span class="muted">editorial listing</span>'}</dd></dl>
        ${orders.length ? `<table style="margin:.75rem 0"><tr><th>When</th><th>Amount</th><th>Status</th></tr>${orders.map((o) => `<tr><td>${fmtDate(o.created_at)}</td><td>${money(o.amount_cents, o.currency)}</td><td>${statusPill(o.status)}</td></tr>`).join('')}</table>` : '<p class="meta">No orders for this tool.</p>'}
        <form method="post" action="/admin/tools/${t.id}/featured" class="row">
          <button class="btn ghost sm" name="action" value="grant" type="submit">Grant 12 months (manual payment)</button>
          ${t.plan === 'featured' ? '<button class="btn ghost sm" name="action" value="revoke" type="submit">Revoke featured</button>' : ''}
        </form>
      </div>
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
    const tax = ${taxonomy}; const other = ${JSON.stringify(OTHER_CATEGORY)};
    document.getElementById('v-sel').addEventListener('change', (e) => { const c = document.getElementById('c-sel'); c.innerHTML = ''; [...(tax[e.target.value] || []), other].forEach((x) => { const o = document.createElement('option'); o.textContent = x; c.appendChild(o); }); });
  </script>`;
}
