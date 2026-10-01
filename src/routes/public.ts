import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { q } from '../db.js';
import { apiBase, templates, checkEmailMx } from '../lib/email.js';
import { createCheckout, paymentsConfigured } from '../lib/dodo.js';
import { publicLayout } from '../lib/html.js';
import { getPost, postToApi, publishedPosts, type PostRow } from '../lib/posts.js';
import { MAX_UPLOAD_BYTES, processPostImage, processThumbnail, storageConfigured, uploadFile, uploadThumbnail } from '../lib/storage.js';
import { bodyFromAnswers, clean, cleanLine, esc, ipHash, isEmail, lines, multi, newToken, uniqueSlug } from '../lib/text.js';
import { publishedTools, saveComparisonFields, toApi, type ComparisonFields, type ToolRow } from '../lib/tools.js';
import { orderLinks } from '../queue.js';
import { comparisonToApi, publishedComparisons } from '../lib/comparisons.js';
import { comparisonFields } from '../lib/forms.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { safeFetchBytes, UnsafeUrlError } from '../lib/safefetch.js';
import { VERTICALS, PRICING, OTHER_CATEGORY, FEATURES, PLATFORMS, DEPLOYMENTS, COMPANY_SIZES, getVertical, isValidCategory } from '../taxonomy.js';
import { enqueueEmail } from '../queue.js';

type Body = Record<string, unknown>;
const str = (b: Body, k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
const TOKEN_RE = /^[a-f0-9]{48}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redirect(reply: FastifyReply, path: string, params: Record<string, string> = {}) {
  const u = new URL(path, config.siteUrl);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return reply.code(303).redirect(u.toString());
}

/** Honeypot, bot check, email shape, and MX record check. Returns an error string or null. */
async function gate(req: FastifyRequest, b: Body, needEmail = true): Promise<string | null> {
  if (str(b, '_gotcha')) return 'Blocked.';
  if (!(await verifyTurnstile(str(b, 'cf-turnstile-response'), req.ip))) return 'The bot check failed. Please go back and try again.';
  if (needEmail) {
    const email = cleanLine(str(b, 'email')).toLowerCase();
    if (!isEmail(email)) return 'Please enter a valid email address.';
    const mxOk = await checkEmailMx(email);
    if (!mxOk) return 'That email address does not appear to exist. Please use your work email.';
  }
  return null;
}

/** Accepts either an uploaded file (Buffer) or an https URL to an image. Returns processed WebP or null when nothing was given. */
async function imageFromSubmission(b: Body, kind: 'tool' | 'post'): Promise<Buffer | null> {
  let input: Buffer | null = null;
  const file = b['thumbnail'];
  if (Buffer.isBuffer(file) && file.length > 0) input = file;
  const url = cleanLine(str(b, 'thumbnail_url'), 500);
  if (!input && url) {
    // Resolved and range-checked first (no internal hosts), no redirects, streamed with a hard 5 MB cap. One generic error
    // for every failure so the response never doubles as a port or host probe.
    try {
      input = await safeFetchBytes(url, { maxBytes: MAX_UPLOAD_BYTES, accept: 'image/*' });
    } catch (e) {
      throw new Error(e instanceof UnsafeUrlError && /too large/.test(e.message) ? 'That image is over 5 MB.' : 'The image URL could not be fetched. Upload the file instead.');
    }
  }
  if (!input) return null;
  return kind === 'tool' ? processThumbnail(input) : (await processPostImage(input)).data;
}

export default async function publicRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    await q('select 1');
    return { ok: true, payments: paymentsConfigured(), storage: storageConfigured(), emailDomainVerified: config.email.domainVerified };
  });

  // ---- Email MX check (used by the submit form for live feedback) ----
  app.get('/api/check-email', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { email } = req.query as { email?: string };
    if (!email || !isEmail(cleanLine(email))) return { valid: false, reason: 'Invalid email format.' };
    const valid = await checkEmailMx(email.toLowerCase());
    return { valid, reason: valid ? undefined : 'That email address does not appear to exist. Please use your work email.' };
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
  app.get('/api/comparisons', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return (await publishedComparisons()).map(comparisonToApi);
  });
  app.get('/api/taxonomy', async () => ({ verticals: VERTICALS, features: FEATURES, platforms: PLATFORMS, deployments: DEPLOYMENTS, companySizes: COMPANY_SIZES }));

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

    const requested = str(b, 'listing_type');
    const listing = requested === 'featured' ? 'featured' : requested === 'sponsored' ? 'sponsored' : requested === 'instant' ? 'instant' : 'basic';
    const email = cleanLine(str(b, 'email')).toLowerCase();
    const submitterName = cleanLine(str(b, 'submitter_name'), 100) || null;
    const company = cleanLine(str(b, 'tool_name'), 80);
    const website = cleanLine(str(b, 'website'), 300);
    if (!company || !/^https?:\/\/\S+\.\S+/.test(website)) return redirect(reply, '/submitted/', { status: 'error', msg: 'Name and a full website URL (starting with https://) are required.' });
    const token = newToken();

    if (listing === 'sponsored') {
      // Pay first: title and draft are optional here and are added from the private link after checkout.
      const title = cleanLine(str(b, 'article_title'), 160) || `Sponsored article from ${company}`;
      const draft = clean(str(b, 'article_draft'), 60000);
      const complete = draft.length >= 20 && !title.startsWith('Sponsored article from ');
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
        `insert into posts (slug, title, body_md, author, kind, status, order_id, company, website, submitter_email, submitter_name, written_by_us, edit_token, thumbnail_url, listing_complete)
         values ($1,$2,$3,$4,'sponsored','pending',$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [slug, title, draft, authorName || company, order.id, company, website, email, authorName || submitterName, writtenByUs, token, thumbnailUrl, complete],
      )).rows[0];
      await enqueueEmail(templates.articleReceived({ to: email, name: authorName || submitterName || '', title, writtenByUs, token, complete }));
      await enqueueEmail(templates.ownerNew({ subject: `Sponsored article: ${title}`, details: [['From', `${company} <${email}>`], ['Written by us', writtenByUs ? 'yes' : 'no'], ['Amount', `$${(amount / 100).toFixed(2)}`]], adminUrl: `${apiBase()}/admin/posts/${post.id}` }));
      return startCheckout(reply, {
        orderId: order.id, email, name: company,
        cart: [{ product_id: config.dodo.products.sponsored, quantity: 1 }, ...(writtenByUs ? [{ product_id: config.dodo.products.writingAddon, quantity: 1 }] : [])],
        returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=sponsored&o=${order.id}`, fallback: { status: 'received', kind: 'sponsored', pay: 'later', o: order.id },
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
    const conclusion = clean(str(b, 'conclusion'), 2000);
    if (!isValidCategory(vertical, category, true)) return redirect(reply, '/submitted/', { status: 'error', msg: 'Please pick a category and subcategory.' });
    if (!(PRICING as readonly string[]).includes(pricing)) return redirect(reply, '/submitted/', { status: 'error', msg: 'Please pick a pricing model.' });

    // Determine profile tier: basic = only core fields filled; full = description sections also provided
    const isFullProfile = shines.length >= 40 && short.length >= 20;
    // A free listing needs at minimum a tagline to show on the card
    if (tagline.length < 5) {
      return redirect(reply, '/submitted/', { status: 'error', msg: 'A tagline is required (shown on the card in the category page).' });
    }
    // A featured listing pays first and completes the description from its private link. Instant publish goes live as typed,
    // so it needs the same fields as a free listing.
    const complete = tagline.length >= 10 && what.length >= 40 && isFullProfile;
    if (listing !== 'featured' && !complete && what.length < 40) {
      return redirect(reply, '/submitted/', { status: 'error', msg: 'Please write at least a couple of sentences in the "What does it do?" field.' });
    }
    const profileTier = isFullProfile ? 'full' : 'basic';
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
      `insert into tools (slug, name, website, tagline, vertical, category, pricing, best_for, thumbnail_url, body_md, plan, submitter_email, submitter_name, notes, edit_token, listing_complete, profile_tier)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [slug, company, website, tagline, vertical, category, pricing, cleanLine(str(b, 'best_for'), 120), thumbnailUrl,
        complete ? bodyFromAnswers(company, { what, shines, short, conclusion }) : (what.length >= 40 ? bodyFromAnswers(company, { what, shines: '', short: '', conclusion: '' }) : ''),
        listing === 'featured' ? 'featured' : 'basic', email, submitterName, clean(str(b, 'notes'), 2000) || null, token, complete, profileTier],
    )).rows[0];
    await saveComparisonFields(tool.id, vertical, comparisonFromBody(b), false);
    await enqueueEmail(templates.toolReceived({ to: email, name: submitterName ?? '', toolName: company, plan: listing, token, complete }));
    await enqueueEmail(templates.ownerNew({ subject: `New ${listing} listing: ${company}`, details: [['Category', `${vertical} / ${category}`], ['Website', website], ['From', `${submitterName ?? ''} <${email}>`]], adminUrl: `${apiBase()}/admin/tools/${tool.id}` }));

    if (listing === 'basic') return redirect(reply, '/submitted/', { status: 'received', tool: slug });
    if (listing === 'instant') {
      // Paid skip-the-queue: the payment webhook publishes the tool (see processPaymentEvent) and an editor reads it afterwards.
      const order = (await q<{ id: string }>("insert into orders (kind, tool_id, email, name, amount_cents) values ('instant', $1, $2, $3, $4) returning id", [tool.id, email, company, config.prices.instant.cents])).rows[0];
      return startCheckout(reply, {
        orderId: order.id, toolId: tool.id, email, name: company,
        cart: [{ product_id: config.dodo.products.instant, quantity: 1 }],
        returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=instant&o=${order.id}`, fallback: { status: 'received', tool: slug, pay: 'later', o: order.id },
      });
    }
    const order = (await q<{ id: string }>("insert into orders (kind, tool_id, email, name, amount_cents) values ('featured', $1, $2, $3, $4) returning id", [tool.id, email, company, config.prices.featured.cents])).rows[0];
    return startCheckout(reply, {
      orderId: order.id, toolId: tool.id, email, name: company,
      cart: [{ product_id: config.dodo.products.featured, quantity: 1 }],
      returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=featured&o=${order.id}`, fallback: { status: 'received', tool: slug, pay: 'later', o: order.id },
    });
  });

  // ---- Order builder (services page): several fixed-price items, one checkout, bundle discount applied by code ----
  app.post('/checkout/order-builder', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    const err = await gate(req, b);
    if (err) return redirect(reply, '/submitted/', { status: 'error', msg: err });
    const email = cleanLine(str(b, 'email')).toLowerCase();
    const company = cleanLine(str(b, 'company'), 80);
    const website = cleanLine(str(b, 'website'), 300);
    const wantFeatured = str(b, 'item_featured') !== '';
    const sponsoredQty = Math.min(5, Math.max(0, parseInt(str(b, 'qty_sponsored'), 10) || 0));
    const writing = str(b, 'writing_addon') !== '';
    const wantDirectory = str(b, 'item_directory') !== '';
    if (!company || !/^https?:\/\/\S+\.\S+/.test(website)) return redirect(reply, '/submitted/', { status: 'error', msg: 'Company name and a full website URL (starting with https://) are required.' });
    const items: { kind: string; qty: number; cents: number; product: string }[] = [];
    if (wantFeatured) items.push({ kind: 'featured', qty: 1, cents: config.prices.featured.cents, product: config.dodo.products.featured });
    if (sponsoredQty) items.push({ kind: 'sponsored', qty: sponsoredQty, cents: config.prices.sponsored.cents, product: config.dodo.products.sponsored });
    if (sponsoredQty && writing) items.push({ kind: 'writing_addon', qty: sponsoredQty, cents: config.prices.writingAddon.cents, product: config.dodo.products.writingAddon });
    if (wantDirectory) items.push({ kind: 'directory_package', qty: 1, cents: config.prices.directoryPackage.cents, product: config.dodo.products.directoryPackage });
    if (!items.length) return redirect(reply, '/submitted/', { status: 'error', msg: 'Pick at least one item.' });
    const subtotal = items.reduce((n, i) => n + i.cents * i.qty, 0);
    const distinct = new Set(items.filter((i) => i.kind !== 'writing_addon').map((i) => i.kind)).size;
    const bundle = distinct >= config.bundle.minItems && config.bundle.percent > 0;
    const discount = bundle ? Math.round(subtotal * config.bundle.percent / 100) : 0;
    const token = newToken();
    // The order row first, so every listing created below can point at it
    const order = (await q<{ id: string }>(
      "insert into orders (kind, email, name, amount_cents, discount_cents, metadata) values ('bundle', $1, $2, $3, $4, $5) returning id",
      [email, company, subtotal - discount, discount, { items: items.map((i) => ({ kind: i.kind, qty: i.qty, cents: i.cents })), website, discount_percent: bundle ? config.bundle.percent : 0, tool_ids: [] }],
    )).rows[0];
    const toolIds: string[] = [];
    if (wantFeatured) {
      const slug = await uniqueSlug(company);
      const t = (await q<{ id: string }>(
        `insert into tools (slug, name, website, tagline, vertical, category, pricing, body_md, plan, submitter_email, submitter_name, edit_token, listing_complete)
         values ($1,$2,$3,'',$4,$5,'Paid','','featured',$6,$7,$8,false) returning id`,
        [slug, company, website, VERTICALS[0].slug, OTHER_CATEGORY, email, cleanLine(str(b, 'name'), 100) || null, token],
      )).rows[0];
      toolIds.push(t.id);
      await q('update orders set tool_id = $2, metadata = metadata || $3 where id = $1', [order.id, t.id, { tool_ids: toolIds }]);
    }
    for (let i = 0; i < sponsoredQty; i++) {
      const title = `Sponsored article ${sponsoredQty > 1 ? i + 1 + ' ' : ''}from ${company}`.replace(/\s+/g, ' ');
      await q(
        `insert into posts (slug, title, body_md, author, kind, status, order_id, company, website, submitter_email, submitter_name, written_by_us, edit_token, listing_complete)
         values ($1,$2,'',$3,'sponsored','pending',$4,$5,$6,$7,$8,$9,$10,false)`,
        [await uniqueSlug(title, 'posts'), title, company, order.id, company, website, email, cleanLine(str(b, 'name'), 100) || null, writing, newToken()],
      );
    }
    await enqueueEmail(templates.ownerNew({
      subject: `Order: ${company}`,
      details: [['Items', items.map((i) => `${i.qty} x ${i.kind}`).join(', ')], ['Total', `$${((subtotal - discount) / 100).toFixed(2)}${discount ? ` (bundle discount $${(discount / 100).toFixed(2)})` : ''}`], ['From', `${company} <${email}>`]],
      adminUrl: `${apiBase()}/admin?tab=orders`,
    }));
    if (bundle && !config.dodo.bundleDiscountCode) {
      // The discount cannot be applied at checkout without a code, so this order is invoiced by hand rather than overcharged.
      app.log.warn({ order: order.id }, 'bundle discount requested but DODO_BUNDLE_DISCOUNT_CODE is not set; order left for a manual payment link');
      return redirect(reply, '/submitted/', { status: 'received', kind: 'bundle', pay: 'later', o: order.id });
    }
    return startCheckout(reply, {
      orderId: order.id, email, name: company, discountCodes: bundle ? [config.dodo.bundleDiscountCode] : [],
      cart: items.map((i) => ({ product_id: i.product, quantity: i.qty })),
      returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=bundle&o=${order.id}`, fallback: { status: 'received', kind: 'bundle', pay: 'later', o: order.id },
    });
  });

  // ---- Order status and private links for the thank-you page. The order id is a random uuid and acts as the secret. ----
  app.get('/checkout/order/:id/summary', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not found' });
    const o = (await q<any>('select * from orders where id = $1', [id])).rows[0];
    if (!o) return reply.code(404).send({ error: 'not found' });
    reply.header('cache-control', 'no-store');
    const links = await orderLinks(o);
    return { status: o.status, kind: o.kind, amountCents: o.amount_cents, discountCents: o.discount_cents ?? 0, items: links.map(([label, url]) => ({ label, url })), payUrl: o.status === 'pending' && paymentsConfigured() ? `${apiBase()}/checkout/order/${o.id}` : null };
  });

  // ---- Re-open the checkout for an order that was never paid (from the thank-you page or the private link) ----
  app.get('/checkout/order/:id', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send('Not found');
    const o = (await q<any>('select * from orders where id = $1', [id])).rows[0];
    if (!o) return reply.code(404).send('Not found');
    if (o.status === 'paid') return redirect(reply, '/submitted/', { status: 'paid', kind: o.kind, o: o.id });
    if (o.status !== 'pending' && o.status !== 'expired' && o.status !== 'failed') return redirect(reply, '/submitted/', { status: 'error', msg: 'This order can no longer be paid. Reply to any email from us for help.' });
    const products = config.dodo.products as Record<string, string>;
    const map: Record<string, string> = { featured: products.featured, sponsored: products.sponsored, writing_addon: products.writingAddon, directory_package: products.directoryPackage, instant: products.instant };
    const cart = o.kind === 'bundle'
      ? ((o.metadata.items ?? []) as { kind: string; qty: number }[]).map((i) => ({ product_id: map[i.kind], quantity: i.qty }))
      : [{ product_id: map[o.kind], quantity: 1 }, ...(o.kind === 'sponsored' && o.metadata.written_by_us ? [{ product_id: products.writingAddon, quantity: 1 }] : [])];
    if (o.status !== 'pending') await q("update orders set status = 'pending' where id = $1", [o.id]);
    return startCheckout(reply, {
      orderId: o.id, toolId: o.tool_id ?? undefined, email: o.email ?? undefined, name: o.name ?? undefined, cart,
      discountCodes: o.metadata.discount_percent && config.dodo.bundleDiscountCode ? [config.dodo.bundleDiscountCode] : [],
      returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=${o.kind}&o=${o.id}`, fallback: { status: 'received', kind: o.kind, pay: 'later', o: o.id },
    });
  });

  // POST only: a GET that creates an order and calls the payment provider can be triggered by any <img src>.
  app.post('/checkout/directory-package', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    if (str(b, '_gotcha')) return redirect(reply, '/thanks/', { type: 'error', msg: 'Blocked.' });
    const email = isEmail(cleanLine(str(b, 'email'))) ? cleanLine(str(b, 'email')).toLowerCase() : undefined;
    const order = (await q<{ id: string }>("insert into orders (kind, email, amount_cents) values ('directory_package', $1, $2) returning id", [email ?? null, config.prices.directoryPackage.cents])).rows[0];
    return startCheckout(reply, { orderId: order.id, email, cart: [{ product_id: config.dodo.products.directoryPackage, quantity: 1 }], returnUrl: `${config.siteUrl}/thanks/?type=directory-package`, fallback: null });
  });

  app.get('/checkout/featured-renewal/:toolId', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { toolId } = req.params as { toolId: string };
    if (!UUID_RE.test(toolId)) return reply.code(404).send('Not found');
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
    const order = item.kind === 'tool'
      ? (await q<any>('select * from orders where (tool_id = $1 or metadata->\'tool_ids\' ? $1::text) order by created_at desc limit 1', [item.row.id])).rows[0]
      : item.row.order_id ? (await q<any>('select * from orders where id = $1', [item.row.order_id])).rows[0] : null;
    reply.type('text/html');
    return publicLayout(item.kind === 'tool' ? item.row.name : item.row.title, item.kind === 'tool' ? toolEditPage(item.row, order) : postEditPage(item.row, order), { flash: qs.flash, flashKind: qs.err ? 'err' : 'ok' });
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
    const wasComplete = (row as any).listing_complete !== false;

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
             status='pending', review_note=null, listing_complete=true, profile_tier='full', updated_at=now() where id=$1`,
          [row.id, website, tagline, vertical, category, pricing, cleanLine(str(b, 'best_for'), 120), body + '\n', thumb],
        );
        await saveComparisonFields(row.id, vertical, comparisonFromBody(b), false);
      } else {
        const title = cleanLine(str(b, 'title'), 160);
        const body = clean(String(b['body_md'] ?? ''), 60000);
        if (!title || body.length < 20) return back('A title and the article text are required.', true);
        const img = await imageFromSubmission(b, 'post');
        const thumb = img ? await uploadFile(`posts/${row.slug}.webp`, img, 'image/webp') : null;
        await q(
          `update posts set title=$2, description=$3, author=$4, author_bio=$5, body_md=$6, thumbnail_url=coalesce($7, thumbnail_url),
             status='pending', review_note=null, listing_complete=true, updated_at=now() where id=$1`,
          [row.id, title, cleanLine(str(b, 'description'), 200), cleanLine(str(b, 'author'), 100) || item.row.author, clean(str(b, 'author_bio'), 600) || null, body + '\n', thumb],
        );
      }
    } catch (e) {
      return back(`Could not save: ${(e as Error).message}`, true);
    }
    if (row.submitter_email) await enqueueEmail(templates.submissionUpdated({ to: row.submitter_email, name: row.submitter_name ?? '', what }));
    await enqueueEmail(templates.ownerNew({ subject: `${wasComplete ? 'Updated' : 'Completed'} ${item.kind}: ${what}`, details: [['Status', wasComplete ? 'back in the queue' : 'ready for review'], ['From', row.submitter_email ?? '']], adminUrl: `${apiBase()}/admin/${item.kind === 'tool' ? 'tools' : 'posts'}/${row.id}` }));
    return back(wasComplete ? 'Saved. Your update is back at the top of the review queue.' : 'Saved. The listing is complete and in the review queue.');
  });

  async function startCheckout(reply: FastifyReply, o: { orderId: string; toolId?: string; email?: string; name?: string; cart: { product_id: string; quantity: number }[]; returnUrl: string; fallback: Record<string, string> | null; discountCodes?: string[] }) {
    if (!paymentsConfigured()) {
      if (o.fallback) return redirect(reply, '/submitted/', o.fallback);
      return redirect(reply, '/thanks/', { type: 'error', msg: 'Online payment is not switched on yet. Email us and we will send a payment link.' });
    }
    try {
      const { checkoutUrl, sessionId } = await createCheckout({ cart: o.cart, email: o.email, name: o.name, returnUrl: o.returnUrl, discountCodes: o.discountCodes, metadata: { order_id: o.orderId, ...(o.toolId ? { tool_id: o.toolId } : {}) } });
      await q('update orders set provider_session_id = $2 where id = $1', [o.orderId, sessionId]);
      return reply.code(303).redirect(checkoutUrl);
    } catch (e) {
      app.log.error({ err: e }, 'checkout failed');
      if (o.fallback) return redirect(reply, '/submitted/', { ...o.fallback, pay: 'failed' });
      return redirect(reply, '/thanks/', { type: 'error', msg: 'Checkout could not be started. Please try again or email us.' });
    }
  }
}

/** The comparison fields as the public forms send them: one item per line for lists, checkboxes for platforms and company size. */
function comparisonFromBody(b: Body): ComparisonFields {
  const trial = parseInt(str(b, 'trial_days'), 10);
  const free = str(b, 'free_tier');
  return {
    pros: lines(str(b, 'pros'), 5, 120),
    cons: lines(str(b, 'cons'), 4, 120),
    key_features: multi(b['key_features']).slice(0, 10),
    platforms: multi(b['platforms']),
    integrations: lines(str(b, 'integrations'), 10, 40, true),
    starting_price: cleanLine(str(b, 'starting_price'), 60) || null,
    free_tier: free === 'yes' ? true : free === 'no' ? false : null,
    trial_days: Number.isFinite(trial) && trial >= 0 && trial <= 365 ? trial : null,
    deployment: cleanLine(str(b, 'deployment'), 20) || null,
    company_size: multi(b['company_size']),
    verdict_line: cleanLine(str(b, 'verdict_line'), 160) || null,
    deal_text: cleanLine(str(b, 'deal_text'), 120) || null,
    deal_code: cleanLine(str(b, 'deal_code'), 40) || null,
    deal_url: cleanLine(str(b, 'deal_url'), 300) || null,
    deal_until: /^\d{4}-\d{2}-\d{2}$/.test(str(b, 'deal_until')) ? str(b, 'deal_until') : null,
  };
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

function orderBlock(order: any): string {
  if (!order) return '';
  const amount = `$${(order.amount_cents / 100).toFixed(2)}`;
  if (order.status === 'paid') return `<div class="card" style="margin-bottom:1rem"><strong>Paid ${amount}</strong> <span class="muted">on ${new Date(order.paid_at ?? order.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Reference ${esc(String(order.id).slice(0, 8).toUpperCase())}. The receipt came from Dodo Payments.</span></div>`;
  if (order.status === 'refunded') return `<div class="notice"><strong>Refunded.</strong> ${amount} was returned to the original payment method.</div>`;
  return `<div class="notice"><strong>Payment pending: ${amount}.</strong> Featured placement and publication start once it is paid. <a class="btn sm" style="margin-left:.5rem" href="/checkout/order/${esc(order.id)}">Pay now</a></div>`;
}

function checklist(items: [string, boolean][]): string {
  const open = items.filter(([, ok]) => !ok);
  if (!open.length) return '';
  return `<div class="card" style="margin-bottom:1rem"><strong>Complete your listing.</strong> <span class="muted">Still needed:</span><ul style="margin:.5rem 0 0 1.2rem;padding:0">${open.map(([label]) => `<li>${esc(label)}</li>`).join('')}</ul><p class="meta" style="margin:.5rem 0 0">Save the form below once these are in and the review starts.</p></div>`;
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

function toolEditPage(t: ToolRow & { edit_token: string; listing_complete?: boolean }, order: any = null): string {
  const editable = t.status === 'pending' || t.status === 'changes_requested';
  const v = getVertical(t.vertical);
  const cats = [...(v?.categories ?? []), OTHER_CATEGORY];
  const taxonomy = JSON.stringify(Object.fromEntries(VERTICALS.map((x) => [x.slug, x.categories])));
  const incomplete = t.listing_complete === false;
  return `<h1>${incomplete ? `Complete the listing for ${esc(t.name)}` : esc(t.name)}</h1>${orderBlock(order)}${incomplete ? checklist([['A real subcategory', t.category !== OTHER_CATEGORY], ['Tagline (10 to 140 characters)', t.tagline.length >= 10], ['Description: what it is, where it shines, where it falls short', t.body_md.trim().length >= 100], ['A screenshot or product image', !!t.thumbnail_url]]) : statusBlock(t.status, t.review_note, t.reject_reason, t.name)}
  ${editable ? `<form class="stack card" method="post" enctype="multipart/form-data"><input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
    ${t.thumbnail_url ? `<img src="${esc(t.thumbnail_url)}" alt="" style="max-width:360px;border-radius:10px;border:1px solid var(--border)">` : ''}
    ${imageFields('Screenshot or product image')}
    <label>Website <input name="website" value="${esc(t.website)}" required></label>
    <label>Tagline <small>max 140 characters</small><input name="tagline" value="${esc(t.tagline)}" maxlength="140" required></label>
    <div class="two"><label>Category <select name="vertical" id="v-sel">${VERTICALS.map((x) => `<option value="${x.slug}" ${x.slug === t.vertical ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label>Subcategory <select name="category" id="c-sel">${cats.map((c) => `<option ${c === t.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label></div>
    <div class="two"><label>Pricing <select name="pricing">${PRICING.map((p) => `<option ${p === t.pricing ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>Best for <input name="best_for" value="${esc(t.best_for)}"></label></div>
    ${comparisonFields(t.vertical, t)}
    <label>Description <small>Plain text or markdown. Keep the four sections: what it is, where it shines, where it falls short, conclusion.</small><textarea name="body_md" rows="18" required>${esc(t.body_md)}</textarea></label>
    <button class="btn" type="submit">Save update</button></form>
    <script>const tax=${taxonomy};const other=${JSON.stringify(OTHER_CATEGORY)};const feats=${JSON.stringify(FEATURES)};document.getElementById('v-sel').addEventListener('change',(e)=>{const c=document.getElementById('c-sel');c.innerHTML='';[...(tax[e.target.value]||[]),other].forEach((x)=>{const o=document.createElement('option');o.textContent=x;c.appendChild(o);});const f=document.getElementById('feat-box');f.innerHTML=(feats[e.target.value]||[]).map((x)=>'<label class="chk"><input type="checkbox" name="key_features" value="'+x.replace(/"/g,'&quot;')+'"> '+x+'</label>').join('');});</script>`
    : t.status === 'published' ? noteForm() : ''}`;
}

function postEditPage(p: PostRow & { listing_complete?: boolean }, order: any = null): string {
  const editable = p.status === 'pending' || p.status === 'changes_requested';
  const incomplete = p.listing_complete === false;
  return `<h1>${incomplete ? (p.written_by_us ? 'Tell us what to write' : 'Add your article') : esc(p.title)}</h1>${orderBlock(order)}${incomplete ? checklist([['A title', !p.title.startsWith('Sponsored article')], [p.written_by_us ? 'Your brief: the angle, the pages to link, anything we must include' : 'The article text (markdown or plain text)', p.body_md.trim().length >= 20]]) : statusBlock(p.status, p.review_note, p.reject_reason, p.title)}
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
