import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { q } from '../db.js';
import { apiBase, templates } from '../lib/email.js';
import { createCheckout, paymentsConfigured } from '../lib/dodo.js';
import { publicLayout } from '../lib/html.js';
import { getPost, postToApi, publishedPosts, type PostRow } from '../lib/posts.js';
import { MAX_UPLOAD_BYTES, processPostImage, processThumbnail, storageConfigured, uploadFile, uploadThumbnail } from '../lib/storage.js';
import { bodyFromAnswers, clean, cleanLine, esc, ipHash, isEmail, newToken, uniqueSlug } from '../lib/text.js';
import { publishedTools, toApi, type ToolRow } from '../lib/tools.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { VERTICALS, PRICING, OTHER_CATEGORY, getVertical, isValidCategory } from '../taxonomy.js';
import { enqueueEmail } from '../queue.js';

type Body = Record<string, unknown>;
const str = (b: Body, k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
const TOKEN_RE = /^[a-f0-9]{48}$/;

function redirect(reply: FastifyReply, path: string, params: Record<string, string> = {}) {
  const u = new URL(path, config.siteUrl);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return reply.code(303).redirect(u.toString());
}

/** Honeypot, bot check, email shape. Returns an error string or null. */
async function gate(req: FastifyRequest, b: Body, needEmail = true): Promise<string | null> {
  if (str(b, '_gotcha')) return 'Blocked.';
  if (!(await verifyTurnstile(str(b, 'cf-turnstile-response'), req.ip))) return 'The bot check failed. Please go back and try again.';
  if (needEmail && !isEmail(cleanLine(str(b, 'email')))) return 'Please enter a valid email address.';
  return null;
}

/** Accepts either an uploaded file (Buffer) or an https URL to an image. Returns processed WebP or null when nothing was given. */
async function imageFromSubmission(b: Body, kind: 'tool' | 'post'): Promise<Buffer | null> {
  let input: Buffer | null = null;
  const file = b['thumbnail'];
  if (Buffer.isBuffer(file) && file.length > 0) input = file;
  const url = cleanLine(str(b, 'thumbnail_url'), 500);
  if (!input && /^https:\/\/\S+/.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'image/*' } }).catch(() => null);
    if (!res || !res.ok) throw new Error('The image URL could not be fetched.');
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_UPLOAD_BYTES) throw new Error('That image is over 5 MB.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_UPLOAD_BYTES) throw new Error('That image is over 5 MB.');
    input = buf;
  }
  if (!input) return null;
  return kind === 'tool' ? processThumbnail(input) : (await processPostImage(input)).data;
}

export default async function publicRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    await q('select 1');
    return { ok: true, payments: paymentsConfigured(), storage: storageConfigured(), emailDomainVerified: config.email.domainVerified };
  });

  app.get('/api/tools', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return (await publishedTools()).map(toApi);
  });
  app.get('/api/tools/counts', async () => {
    const { rows } = await q<{ vertical: string; n: string }>("select vertical, count(*)::text as n from tools where status = 'published' group by vertical");
    return Object.fromEntries(rows.map((r) => [r.vertical, Number(r.n)]));
  });
  app.get('/api/posts', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return (await publishedPosts()).map(postToApi);
  });
  app.get('/api/taxonomy', async () => VERTICALS);

  // ---- Simple forms (form-encoded, redirect back to the site) ----
  const formLimit = { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } };

  app.post('/forms/newsletter', formLimit, async (req, reply) => {
    const b = req.body as Body;
    const err = await gate(req, b);
    if (err) return redirect(reply, '/thanks/', { type: 'error', msg: err });
    const email = cleanLine(str(b, 'email')).toLowerCase();
    await q('insert into subscribers (email) values ($1) on conflict (email) do update set unsubscribed_at = null', [email]);
    return redirect(reply, '/thanks/', { type: 'newsletter' });
  });

  for (const [path, kind, label] of [
    ['/forms/contact', 'contact', 'Contact'],
    ['/forms/service-order', 'service_order', 'Service order'],
    ['/forms/guest-pitch', 'guest_pitch', 'Guest post pitch'],
  ] as const) {
    app.post(path, formLimit, async (req, reply) => {
      const b = req.body as Body;
      const err = await gate(req, b);
      if (err) return redirect(reply, '/thanks/', { type: 'error', msg: err });
      const message = clean(str(b, 'message'), 8000);
      if (message.length < 5) return redirect(reply, '/thanks/', { type: 'error', msg: 'Please add a few words in the details box.' });
      const row = { name: cleanLine(str(b, 'name')), email: cleanLine(str(b, 'email')).toLowerCase(), company: cleanLine(str(b, 'company')), interest: cleanLine(str(b, 'interest')), message };
      const { rows } = await q<{ id: string }>(
        'insert into messages (kind, name, email, company, interest, message, ip_hash) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [kind, row.name, row.email, row.company, row.interest, row.message, ipHash(req.ip)],
      );
      await enqueueEmail(templates.ownerNew({
        subject: `${label}: ${row.interest || row.company || row.email}`,
        details: [['From', `${row.name} <${row.email}>`], ...(row.company ? [['Company', row.company] as [string, string]] : []), ...(row.interest ? [['Interest', row.interest] as [string, string]] : [])],
        body: row.message,
        adminUrl: `${apiBase()}/admin?tab=messages#m-${rows[0].id}`,
      }));
      return redirect(reply, '/thanks/', { type: kind.replace('_', '-') });
    });
  }

  // ---- Tool submission and sponsored article (multipart; may end on a Dodo checkout page) ----
  app.post('/submissions', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    const err = await gate(req, b);
    if (err) return redirect(reply, '/submitted/', { status: 'error', msg: err });

    const listing = str(b, 'listing_type') === 'featured' ? 'featured' : str(b, 'listing_type') === 'sponsored' ? 'sponsored' : 'basic';
    const email = cleanLine(str(b, 'email')).toLowerCase();
    const submitterName = cleanLine(str(b, 'submitter_name'), 100) || null;
    const company = cleanLine(str(b, 'tool_name'), 80);
    const website = cleanLine(str(b, 'website'), 300);
    if (!company || !/^https?:\/\/\S+\.\S+/.test(website)) return redirect(reply, '/submitted/', { status: 'error', msg: 'Name and a full website URL (starting with https://) are required.' });
    const token = newToken();

    if (listing === 'sponsored') {
      const title = cleanLine(str(b, 'article_title'), 160);
      const draft = clean(str(b, 'article_draft'), 60000);
      if (!title || draft.length < 20) return redirect(reply, '/submitted/', { status: 'error', msg: 'A proposed title and a draft or pitch are required.' });
      const writtenByUs = str(b, 'written_by_us') !== '';
      const authorName = cleanLine(str(b, 'author_name'), 100);
      const amount = config.prices.sponsored.cents + (writtenByUs ? config.prices.writingAddon.cents : 0);
      const order = (await q<{ id: string }>(
        "insert into orders (kind, email, name, amount_cents, metadata) values ('sponsored', $1, $2, $3, $4) returning id",
        [email, company, amount, { written_by_us: writtenByUs, title }],
      )).rows[0];
      const slug = await uniqueSlug(title, 'posts');
      let thumbnailUrl: string | null = null;
      try {
        const img = await imageFromSubmission(b, 'post');
        if (img) thumbnailUrl = await uploadFile(`posts/${slug}.webp`, img, 'image/webp');
      } catch (e) {
        return redirect(reply, '/submitted/', { status: 'error', msg: `Image problem: ${(e as Error).message}` });
      }
      const post = (await q<{ id: string }>(
        `insert into posts (slug, title, body_md, author, kind, status, order_id, company, website, submitter_email, submitter_name, written_by_us, edit_token, thumbnail_url)
         values ($1,$2,$3,$4,'sponsored','pending',$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [slug, title, draft, authorName || company, order.id, company, website, email, authorName || submitterName, writtenByUs, token, thumbnailUrl],
      )).rows[0];
      await enqueueEmail(templates.articleReceived({ to: email, name: authorName || submitterName || '', title, writtenByUs, token }));
      await enqueueEmail(templates.ownerNew({ subject: `Sponsored article: ${title}`, details: [['From', `${company} <${email}>`], ['Written by us', writtenByUs ? 'yes' : 'no'], ['Amount', `$${(amount / 100).toFixed(2)}`]], adminUrl: `${apiBase()}/admin/posts/${post.id}` }));
      return startCheckout(reply, {
        orderId: order.id, email, name: company,
        cart: [{ product_id: config.dodo.products.sponsored, quantity: 1 }, ...(writtenByUs ? [{ product_id: config.dodo.products.writingAddon, quantity: 1 }] : [])],
        returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=sponsored`, fallback: { status: 'received', kind: 'sponsored', pay: 'later' },
      });
    }

    // Tool listing (basic or featured)
    const vertical = cleanLine(str(b, 'vertical'), 40);
    const category = cleanLine(str(b, 'category'), 60);
    const pricing = cleanLine(str(b, 'pricing'), 20);
    const tagline = cleanLine(str(b, 'tagline'), 140);
    const what = clean(str(b, 'what_it_does'), 4000);
    const shines = clean(str(b, 'where_it_shines'), 4000);
    const short = clean(str(b, 'where_it_falls_short'), 4000);
    if (!isValidCategory(vertical, category, true)) return redirect(reply, '/submitted/', { status: 'error', msg: 'Please pick a category and subcategory.' });
    if (!(PRICING as readonly string[]).includes(pricing)) return redirect(reply, '/submitted/', { status: 'error', msg: 'Please pick a pricing model.' });
    if (tagline.length < 10 || what.length < 40 || shines.length < 40 || short.length < 20) {
      return redirect(reply, '/submitted/', { status: 'error', msg: 'The tagline and the three description answers are required. A sentence or two each is enough.' });
    }
    const slug = await uniqueSlug(company);
    let thumbnailUrl: string | null = null;
    try {
      const img = await imageFromSubmission(b, 'tool');
      if (img) thumbnailUrl = await uploadThumbnail(slug, img);
    } catch (e) {
      req.log.warn({ err: e }, 'thumbnail rejected');
      return redirect(reply, '/submitted/', { status: 'error', msg: `Image problem: ${(e as Error).message}` });
    }
    const tool = (await q<{ id: string }>(
      `insert into tools (slug, name, website, tagline, vertical, category, pricing, best_for, thumbnail_url, body_md, plan, submitter_email, submitter_name, notes, edit_token)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [slug, company, website, tagline, vertical, category, pricing, cleanLine(str(b, 'best_for'), 120), thumbnailUrl,
        bodyFromAnswers(company, { what, shines, short, conclusion: clean(str(b, 'conclusion'), 2000) }),
        listing === 'featured' ? 'featured' : 'basic', email, submitterName, clean(str(b, 'notes'), 2000) || null, token],
    )).rows[0];
    await enqueueEmail(templates.toolReceived({ to: email, name: submitterName ?? '', toolName: company, plan: listing, token }));
    await enqueueEmail(templates.ownerNew({ subject: `New ${listing} listing: ${company}`, details: [['Category', `${vertical} / ${category}`], ['Website', website], ['From', `${submitterName ?? ''} <${email}>`]], adminUrl: `${apiBase()}/admin/tools/${tool.id}` }));

    if (listing !== 'featured') return redirect(reply, '/submitted/', { status: 'received', tool: slug });
    const order = (await q<{ id: string }>("insert into orders (kind, tool_id, email, name, amount_cents) values ('featured', $1, $2, $3, $4) returning id", [tool.id, email, company, config.prices.featured.cents])).rows[0];
    return startCheckout(reply, {
      orderId: order.id, toolId: tool.id, email, name: company,
      cart: [{ product_id: config.dodo.products.featured, quantity: 1 }],
      returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=featured&tool=${slug}`, fallback: { status: 'received', tool: slug, pay: 'later' },
    });
  });

  app.get('/checkout/directory-package', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const qs = req.query as Record<string, string>;
    const email = isEmail(cleanLine(qs.email ?? '')) ? cleanLine(qs.email).toLowerCase() : undefined;
    const order = (await q<{ id: string }>("insert into orders (kind, email, amount_cents) values ('directory_package', $1, $2) returning id", [email ?? null, config.prices.directoryPackage.cents])).rows[0];
    return startCheckout(reply, { orderId: order.id, email, cart: [{ product_id: config.dodo.products.directoryPackage, quantity: 1 }], returnUrl: `${config.siteUrl}/thanks/?type=directory-package`, fallback: null });
  });

  app.get('/checkout/featured-renewal/:toolId', async (req, reply) => {
    const { toolId } = req.params as { toolId: string };
    const t = (await q<{ id: string; name: string; slug: string; submitter_email: string | null }>('select id, name, slug, submitter_email from tools where id::text = $1', [toolId])).rows[0];
    if (!t) return reply.code(404).send('Not found');
    const order = (await q<{ id: string }>("insert into orders (kind, tool_id, email, name, amount_cents) values ('featured', $1, $2, $3, $4) returning id", [t.id, t.submitter_email, t.name, config.prices.featured.cents])).rows[0];
    return startCheckout(reply, { orderId: order.id, toolId: t.id, email: t.submitter_email ?? undefined, name: t.name, cart: [{ product_id: config.dodo.products.featured, quantity: 1 }], returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=featured&tool=${t.slug}`, fallback: null });
  });

  // ---- Private edit link for submitters (sent in every email) ----
  app.get('/s/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const item = await findByToken(token);
    if (!item) return reply.code(404).type('text/html').send(publicLayout('Not found', '<div class="card"><h1>Link not found</h1><p class="muted">This edit link is not valid. Reply to any email from us and we will send a fresh one.</p></div>'));
    const qs = req.query as Record<string, string>;
    reply.type('text/html');
    return publicLayout(item.kind === 'tool' ? item.row.name : item.row.title, item.kind === 'tool' ? toolEditPage(item.row) : postEditPage(item.row), { flash: qs.flash, flashKind: qs.err ? 'err' : 'ok' });
  });

  app.post('/s/:token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const item = await findByToken(token);
    if (!item) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Body;
    if (str(b, '_gotcha')) return reply.code(400).send('Blocked');
    const back = (flash: string, err = false) => reply.code(303).redirect(`/s/${token}?flash=${encodeURIComponent(flash)}${err ? '&err=1' : ''}`);
    const row = item.row;
    const what = item.kind === 'tool' ? item.row.name : item.row.title;
    const editable = row.status === 'pending' || row.status === 'changes_requested';

    if (!editable) {
      // Live or rejected: the submitter can only send a note.
      const message = clean(str(b, 'message'), 4000);
      if (message.length < 5) return back('Please write a few words.', true);
      await q('insert into messages (kind, name, email, company, message, ip_hash) values ($1,$2,$3,$4,$5,$6)', ['contact', row.submitter_name, row.submitter_email ?? '', what, message, ipHash(req.ip)]);
      await enqueueEmail(templates.ownerNew({ subject: `Change request on live ${item.kind}: ${what}`, details: [['From', row.submitter_email ?? '']], body: message, adminUrl: `${apiBase()}/admin/${item.kind === 'tool' ? 'tools' : 'posts'}/${row.id}` }));
      return back('Thanks, we have your note and will reply by email.');
    }

    try {
      if (item.kind === 'tool') {
        const vertical = cleanLine(str(b, 'vertical'), 40);
        const category = cleanLine(str(b, 'category'), 60);
        const pricing = cleanLine(str(b, 'pricing'), 20);
        const tagline = cleanLine(str(b, 'tagline'), 140);
        const website = cleanLine(str(b, 'website'), 300);
        const body = clean(String(b['body_md'] ?? ''), 20000);
        if (!isValidCategory(vertical, category, true) || !(PRICING as readonly string[]).includes(pricing) || tagline.length < 10 || body.length < 100 || !/^https?:\/\/\S+\.\S+/.test(website)) {
          return back('Please check the required fields: website, tagline (10+ characters), category, pricing and the description.', true);
        }
        const img = await imageFromSubmission(b, 'tool');
        const thumb = img ? await uploadThumbnail(row.slug, img) : null;
        await q(
          `update tools set website=$2, tagline=$3, vertical=$4, category=$5, pricing=$6, best_for=$7, body_md=$8, thumbnail_url=coalesce($9, thumbnail_url),
             status='pending', review_note=null, updated_at=now() where id=$1`,
          [row.id, website, tagline, vertical, category, pricing, cleanLine(str(b, 'best_for'), 120), body + '\n', thumb],
        );
      } else {
        const title = cleanLine(str(b, 'title'), 160);
        const body = clean(String(b['body_md'] ?? ''), 60000);
        if (!title || body.length < 20) return back('A title and the article text are required.', true);
        const img = await imageFromSubmission(b, 'post');
        const thumb = img ? await uploadFile(`posts/${row.slug}.webp`, img, 'image/webp') : null;
        await q(
          `update posts set title=$2, description=$3, author=$4, author_bio=$5, body_md=$6, thumbnail_url=coalesce($7, thumbnail_url),
             status='pending', review_note=null, updated_at=now() where id=$1`,
          [row.id, title, cleanLine(str(b, 'description'), 200), cleanLine(str(b, 'author'), 100) || item.row.author, clean(str(b, 'author_bio'), 600) || null, body + '\n', thumb],
        );
      }
    } catch (e) {
      return back(`Could not save: ${(e as Error).message}`, true);
    }
    if (row.submitter_email) await enqueueEmail(templates.submissionUpdated({ to: row.submitter_email, name: row.submitter_name ?? '', what }));
    await enqueueEmail(templates.ownerNew({ subject: `Updated ${item.kind}: ${what}`, details: [['Status', 'back in the queue'], ['From', row.submitter_email ?? '']], adminUrl: `${apiBase()}/admin/${item.kind === 'tool' ? 'tools' : 'posts'}/${row.id}` }));
    return back('Saved. Your update is back at the top of the review queue.');
  });

  async function startCheckout(reply: FastifyReply, o: { orderId: string; toolId?: string; email?: string; name?: string; cart: { product_id: string; quantity: number }[]; returnUrl: string; fallback: Record<string, string> | null }) {
    if (!paymentsConfigured()) {
      if (o.fallback) return redirect(reply, '/submitted/', o.fallback);
      return redirect(reply, '/thanks/', { type: 'error', msg: 'Online payment is not switched on yet. Email us and we will send a payment link.' });
    }
    try {
      const { checkoutUrl, sessionId } = await createCheckout({ cart: o.cart, email: o.email, name: o.name, returnUrl: o.returnUrl, metadata: { order_id: o.orderId, ...(o.toolId ? { tool_id: o.toolId } : {}) } });
      await q('update orders set provider_session_id = $2 where id = $1', [o.orderId, sessionId]);
      return reply.code(303).redirect(checkoutUrl);
    } catch (e) {
      app.log.error({ err: e }, 'checkout failed');
      if (o.fallback) return redirect(reply, '/submitted/', { ...o.fallback, pay: 'failed' });
      return redirect(reply, '/thanks/', { type: 'error', msg: 'Checkout could not be started. Please try again or email us.' });
    }
  }
}

type Found = { kind: 'tool'; row: ToolRow & { edit_token: string } } | { kind: 'post'; row: PostRow };
async function findByToken(token: string): Promise<Found | null> {
  if (!TOKEN_RE.test(token)) return null;
  const t = (await q<ToolRow & { edit_token: string }>('select * from tools where edit_token = $1', [token])).rows[0];
  if (t) return { kind: 'tool', row: t };
  const p = (await q<PostRow>('select * from posts where edit_token = $1', [token])).rows[0];
  if (p) return { kind: 'post', row: p };
  return null;
}

function statusBlock(status: string, reviewNote: string | null, rejectReason: string | null, what: string): string {
  if (status === 'changes_requested') return `<div class="notice"><strong>The reviewer asked for a change.</strong><br>${esc(reviewNote ?? '')}<br><span class="meta">Save your update below and it goes straight back to the queue.</span></div>`;
  if (status === 'published') return `<div class="card" style="margin-bottom:1rem"><strong>${esc(what)} is live.</strong> <span class="muted">Edits to a live page go through a person. Tell us what to change and we will do it.</span></div>`;
  if (status === 'rejected') return `<div class="notice"><strong>Not listed.</strong> ${esc(rejectReason ?? '')}</div>`;
  return `<div class="card" style="margin-bottom:1rem"><strong>In the review queue.</strong> <span class="muted">You can update anything below until a person has reviewed it.</span></div>`;
}

const imageFields = (label: string) => `<label>${label} <input type="file" name="thumbnail" accept="image/png,image/jpeg,image/webp"><small>PNG, JPG or WebP up to 5 MB. Leave empty to keep the current image.</small></label>
  <label>Or an image URL <input type="url" name="thumbnail_url" placeholder="https://"></label>`;

const noteForm = () => `<form class="stack card" method="post"><input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off"><label>What should we change? <textarea name="message" required></textarea></label><button class="btn" type="submit">Send to the reviewer</button></form>`;

function toolEditPage(t: ToolRow & { edit_token: string }): string {
  const editable = t.status === 'pending' || t.status === 'changes_requested';
  const v = getVertical(t.vertical);
  const cats = [...(v?.categories ?? []), OTHER_CATEGORY];
  const taxonomy = JSON.stringify(Object.fromEntries(VERTICALS.map((x) => [x.slug, x.categories])));
  return `<h1>${esc(t.name)}</h1>${statusBlock(t.status, t.review_note, t.reject_reason, t.name)}
  ${editable ? `<form class="stack card" method="post" enctype="multipart/form-data"><input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
    ${t.thumbnail_url ? `<img src="${esc(t.thumbnail_url)}" alt="" style="max-width:360px;border-radius:10px;border:1px solid var(--border)">` : ''}
    ${imageFields('Screenshot or product image')}
    <label>Website <input name="website" value="${esc(t.website)}" required></label>
    <label>Tagline <small>max 140 characters</small><input name="tagline" value="${esc(t.tagline)}" maxlength="140" required></label>
    <div class="two"><label>Category <select name="vertical" id="v-sel">${VERTICALS.map((x) => `<option value="${x.slug}" ${x.slug === t.vertical ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label>Subcategory <select name="category" id="c-sel">${cats.map((c) => `<option ${c === t.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label></div>
    <div class="two"><label>Pricing <select name="pricing">${PRICING.map((p) => `<option ${p === t.pricing ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>Best for <input name="best_for" value="${esc(t.best_for)}"></label></div>
    <label>Description <small>Plain text or markdown. Keep the four sections: what it is, where it shines, where it falls short, conclusion.</small><textarea name="body_md" rows="18" required>${esc(t.body_md)}</textarea></label>
    <button class="btn" type="submit">Save update</button></form>
    <script>const tax=${taxonomy};const other=${JSON.stringify(OTHER_CATEGORY)};document.getElementById('v-sel').addEventListener('change',(e)=>{const c=document.getElementById('c-sel');c.innerHTML='';[...(tax[e.target.value]||[]),other].forEach((x)=>{const o=document.createElement('option');o.textContent=x;c.appendChild(o);});});</script>`
    : t.status === 'published' ? noteForm() : ''}`;
}

function postEditPage(p: PostRow): string {
  const editable = p.status === 'pending' || p.status === 'changes_requested';
  return `<h1>${esc(p.title)}</h1>${statusBlock(p.status, p.review_note, p.reject_reason, p.title)}
  ${editable ? `<form class="stack card" method="post" enctype="multipart/form-data"><input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
    ${p.thumbnail_url ? `<img src="${esc(p.thumbnail_url)}" alt="" style="max-width:360px;border-radius:10px;border:1px solid var(--border)">` : ''}
    ${imageFields('Cover image (16:9)')}
    <label>Title <input name="title" value="${esc(p.title)}" maxlength="160" required></label>
    <label>Summary <small>One or two sentences, max 200 characters, shown in listings and search results.</small><input name="description" value="${esc(p.description)}" maxlength="200"></label>
    <div class="two"><label>Author name <input name="author" value="${esc(p.author)}"></label><label>Author bio <small>one or two sentences</small><input name="author_bio" value="${esc(p.author_bio ?? '')}"></label></div>
    <label>Article <small>Markdown. Headings with ##, links as [text](url).</small><textarea name="body_md" rows="24" required>${esc(p.body_md)}</textarea></label>
    <button class="btn" type="submit">Save update</button></form>`
    : p.status === 'published' ? noteForm() : ''}`;
}
