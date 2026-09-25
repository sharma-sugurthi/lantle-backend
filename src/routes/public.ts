import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { q } from '../db.js';
import { templates } from '../lib/email.js';
import { createCheckout, paymentsConfigured } from '../lib/dodo.js';
import { processThumbnail, storageConfigured, uploadThumbnail } from '../lib/storage.js';
import { bodyFromAnswers, clean, cleanLine, ipHash, isEmail, uniqueSlug } from '../lib/text.js';
import { publishedTools, toApi } from '../lib/tools.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { VERTICALS, PRICING, isValidCategory } from '../taxonomy.js';
import { enqueueEmail } from '../queue.js';

type Body = Record<string, unknown>;
const str = (b: Body, k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
const apiBaseFrom = (req: FastifyRequest) => `${req.protocol}://${req.hostname}`;

function redirect(reply: FastifyReply, path: string, params: Record<string, string> = {}) {
  const u = new URL(path, config.siteUrl);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return reply.code(303).redirect(u.toString());
}

/** Honeypot, bot check, email shape. Returns an error string or null. */
async function gate(req: FastifyRequest, b: Body): Promise<string | null> {
  if (str(b, '_gotcha')) return 'Blocked.';
  if (!(await verifyTurnstile(str(b, 'cf-turnstile-response'), req.ip))) return 'The bot check failed. Please go back and try again.';
  if (!isEmail(cleanLine(str(b, 'email')))) return 'Please enter a valid email address.';
  return null;
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

  app.get('/api/taxonomy', async () => VERTICALS);

  // ---- Simple forms: contact, service order, guest pitch, newsletter (form-encoded, redirect back to the site) ----
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
      const row = {
        name: cleanLine(str(b, 'name')), email: cleanLine(str(b, 'email')).toLowerCase(), company: cleanLine(str(b, 'company')),
        interest: cleanLine(str(b, 'interest')), message,
      };
      const { rows } = await q<{ id: string }>(
        'insert into messages (kind, name, email, company, interest, message, ip_hash) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [kind, row.name, row.email, row.company, row.interest, row.message, ipHash(req.ip)],
      );
      await enqueueEmail(templates.ownerNew({
        subject: `${label}: ${row.interest || row.company || row.email}`,
        lines: [`From: ${row.name} <${row.email}>`, row.company ? `Company: ${row.company}` : '', row.interest ? `Interest: ${row.interest}` : '', '', row.message].filter((l) => l !== ''),
        adminUrl: `${apiBaseFrom(req)}/admin?tab=messages#m-${rows[0].id}`,
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
    const company = cleanLine(str(b, 'tool_name'), 80);
    const website = cleanLine(str(b, 'website'), 300);
    if (!company || !/^https?:\/\/\S+\.\S+/.test(website)) return redirect(reply, '/submitted/', { status: 'error', msg: 'Name and a full website URL (starting with https://) are required.' });
    const returnBase = apiBaseFrom(req);

    if (listing === 'sponsored') {
      const title = cleanLine(str(b, 'article_title'), 160);
      const draft = clean(str(b, 'article_draft'), 60000);
      if (!title || draft.length < 20) return redirect(reply, '/submitted/', { status: 'error', msg: 'A proposed title and a draft or pitch are required.' });
      const writtenByUs = str(b, 'written_by_us') !== '';
      const amount = config.prices.sponsored.cents + (writtenByUs ? config.prices.writingAddon.cents : 0);
      const order = (await q<{ id: string }>(
        "insert into orders (kind, email, name, amount_cents, metadata) values ('sponsored', $1, $2, $3, $4) returning id",
        [email, company, amount, { written_by_us: writtenByUs, title }],
      )).rows[0];
      await q(
        'insert into articles (order_id, company, website, email, author_name, title, draft, written_by_us) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [order.id, company, website, email, cleanLine(str(b, 'author_name'), 100), title, draft, writtenByUs],
      );
      await enqueueEmail(templates.ownerNew({ subject: `Sponsored article: ${title}`, lines: [`From: ${company} <${email}>`, `Written by us: ${writtenByUs ? 'yes' : 'no'}`], adminUrl: `${returnBase}/admin?tab=orders` }));
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
    const file = b['thumbnail'];
    if (Buffer.isBuffer(file) && file.length > 0) {
      try {
        thumbnailUrl = await uploadThumbnail(slug, await processThumbnail(file));
      } catch (e) {
        req.log.warn({ err: e }, 'thumbnail rejected');
        return redirect(reply, '/submitted/', { status: 'error', msg: `Image problem: ${(e as Error).message}` });
      }
    }
    const tool = (await q<{ id: string }>(
      `insert into tools (slug, name, website, tagline, vertical, category, pricing, best_for, thumbnail_url, body_md, plan, submitter_email, submitter_name, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [slug, company, website, tagline, vertical, category, pricing, cleanLine(str(b, 'best_for'), 120), thumbnailUrl,
        bodyFromAnswers(company, { what, shines, short, conclusion: clean(str(b, 'conclusion'), 2000) }),
        listing === 'featured' ? 'featured' : 'basic', email, cleanLine(str(b, 'submitter_name'), 100) || null, clean(str(b, 'notes'), 2000) || null],
    )).rows[0];

    await enqueueEmail(templates.submissionReceived({ to: email, name: '', toolName: company, plan: listing }));
    await enqueueEmail(templates.ownerNew({ subject: `New ${listing} listing: ${company}`, lines: [`${vertical} / ${category}`, website, `From: ${email}`], adminUrl: `${returnBase}/admin/tools/${tool.id}` }));

    if (listing !== 'featured') return redirect(reply, '/submitted/', { status: 'received', tool: slug });

    const order = (await q<{ id: string }>(
      "insert into orders (kind, tool_id, email, name, amount_cents) values ('featured', $1, $2, $3, $4) returning id",
      [tool.id, email, company, config.prices.featured.cents],
    )).rows[0];
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
    return startCheckout(reply, {
      orderId: order.id, email, cart: [{ product_id: config.dodo.products.directoryPackage, quantity: 1 }],
      returnUrl: `${config.siteUrl}/thanks/?type=directory-package`, fallback: null,
    });
  });

  app.get('/checkout/featured-renewal/:toolId', async (req, reply) => {
    const { toolId } = req.params as { toolId: string };
    const t = (await q<{ id: string; name: string; slug: string; submitter_email: string | null }>('select id, name, slug, submitter_email from tools where id::text = $1', [toolId])).rows[0];
    if (!t) return reply.code(404).send('Not found');
    const order = (await q<{ id: string }>("insert into orders (kind, tool_id, email, name, amount_cents) values ('featured', $1, $2, $3, $4) returning id", [t.id, t.submitter_email, t.name, config.prices.featured.cents])).rows[0];
    return startCheckout(reply, {
      orderId: order.id, toolId: t.id, email: t.submitter_email ?? undefined, name: t.name,
      cart: [{ product_id: config.dodo.products.featured, quantity: 1 }],
      returnUrl: `${config.siteUrl}/submitted/?status=paid&kind=featured&tool=${t.slug}`, fallback: null,
    });
  });

  async function startCheckout(reply: FastifyReply, o: {
    orderId: string; toolId?: string; email?: string; name?: string; cart: { product_id: string; quantity: number }[];
    returnUrl: string; fallback: Record<string, string> | null;
  }) {
    if (!paymentsConfigured()) {
      // Before Dodo is live: keep the request, tell the owner, and let them send a payment link by hand.
      if (o.fallback) return redirect(reply, '/submitted/', o.fallback);
      return redirect(reply, '/thanks/', { type: 'error', msg: 'Online payment is not switched on yet. Email us and we will send a payment link.' });
    }
    try {
      const { checkoutUrl, sessionId } = await createCheckout({
        cart: o.cart, email: o.email, name: o.name, returnUrl: o.returnUrl,
        metadata: { order_id: o.orderId, ...(o.toolId ? { tool_id: o.toolId } : {}) },
      });
      await q('update orders set provider_session_id = $2 where id = $1', [o.orderId, sessionId]);
      return reply.code(303).redirect(checkoutUrl);
    } catch (e) {
      app.log.error({ err: e }, 'checkout failed');
      if (o.fallback) return redirect(reply, '/submitted/', { ...o.fallback, pay: 'failed' });
      return redirect(reply, '/thanks/', { type: 'error', msg: 'Checkout could not be started. Please try again or email us.' });
    }
  }
}
