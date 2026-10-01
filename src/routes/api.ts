import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { q } from '../db.js';
import { publishedTools, toApi, type ToolRow } from '../lib/tools.js';
import { publishedComparisons, comparisonToApi, orderPair } from '../lib/comparisons.js';
import { VERTICALS } from '../taxonomy.js';

/**
 * Public, key-less JSON API (/api/v1). Open to every origin, cached for 60 seconds, rate limited by the global limiter.
 * Returns structured facts and the review URL, never the full review body: the site is where the reviews live.
 */
type PublicTool = Omit<ReturnType<typeof toApi>, 'body'> & { url: string };

const CACHE_MS = 60_000;
let cache: { at: number; tools: PublicTool[]; rows: ToolRow[] } | null = null;
async function tools(): Promise<{ tools: PublicTool[]; rows: ToolRow[] }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const rows = await publishedTools();
  const list = rows.map((r) => {
    const { body: _body, ...rest } = toApi(r);
    return { ...rest, url: `${config.siteUrl}/tools/${r.slug}/` };
  });
  cache = { at: Date.now(), tools: list, rows };
  return cache;
}

/** Editorial order: rating, then editor's pick, then name. Paid placement is never an input. */
const editorial = (a: PublicTool, b: PublicTool) => (b.rating ?? 0) - (a.rating ?? 0) || Number(b.editorsPick) - Number(a.editorsPick) || a.name.localeCompare(b.name);
const str = (v: unknown, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export default async function apiRoutes(app: FastifyInstance) {
  // Open to every origin. The global @fastify/cors instance is scoped to the site's origins; these GET-only routes override
  // it here (the hook is encapsulated to this plugin's routes). Simple GETs need no preflight.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET');
  });

  app.get('/api/v1/tools', async (req) => {
    const qs = req.query as Record<string, unknown>;
    const needle = str(qs.q).toLowerCase();
    const vertical = str(qs.vertical);
    const category = str(qs.category);
    const pricing = str(qs.pricing, 20);
    const limit = Math.min(200, Math.max(1, Number(qs.limit) || 200));
    const { tools: all } = await tools();
    const items = all
      .filter((t) => !vertical || t.vertical === vertical)
      .filter((t) => !category || t.category.toLowerCase() === category.toLowerCase())
      .filter((t) => !pricing || t.pricing.toLowerCase() === pricing.toLowerCase())
      .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.tagline.toLowerCase().includes(needle) || t.category.toLowerCase().includes(needle))
      .sort(editorial)
      .slice(0, limit);
    return { count: items.length, items };
  });

  app.get('/api/v1/tools/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const t = (await tools()).tools.find((x) => x.slug === slug);
    if (!t) return reply.code(404).send({ error: 'not found' });
    return t;
  });

  app.get('/api/v1/tools/:slug/alternatives', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { tools: all } = await tools();
    const t = all.find((x) => x.slug === slug);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const items = all.filter((x) => x.category === t.category && x.slug !== t.slug).sort(editorial);
    return { tool: t.slug, category: t.category, url: `${config.siteUrl}/tools/alternatives/${t.slug}/`, count: items.length, items };
  });

  app.get('/api/v1/compare', async (req, reply) => {
    const { a, b } = req.query as { a?: string; b?: string };
    if (!a || !b || a === b) return reply.code(400).send({ error: 'pass two different slugs as a and b' });
    const { tools: all } = await tools();
    const ta = all.find((x) => x.slug === a);
    const tb = all.find((x) => x.slug === b);
    if (!ta || !tb) return reply.code(404).send({ error: 'not found' });
    const [x, y] = orderPair(a, b);
    const verdict = (await publishedComparisons()).find((c) => c.tool_a === x && c.tool_b === y);
    const samePage = ta.category === tb.category || !!verdict;
    return { a: ta, b: tb, url: samePage ? `${config.siteUrl}/tools/compare/${x}-vs-${y}/` : null, verdict: verdict ? comparisonToApi(verdict) : null };
  });

  app.get('/api/v1/deals', async () => {
    const { tools: all } = await tools();
    const items = all.filter((t) => t.deal).sort(editorial).map((t) => ({ slug: t.slug, name: t.name, category: t.category, url: t.url, website: t.website, deal: t.deal }));
    return { count: items.length, items };
  });

  app.get('/api/v1/categories', async () => {
    const { rows } = await q<{ vertical: string; category: string; n: string }>("select vertical, category, count(*)::text as n from tools where status = 'published' group by vertical, category");
    return VERTICALS.map((v) => ({
      slug: v.slug,
      name: v.name,
      url: `${config.siteUrl}/categories/${v.slug}/`,
      tools: rows.filter((r) => r.vertical === v.slug).reduce((s, r) => s + Number(r.n), 0),
      categories: v.categories.map((c) => ({ name: c, tools: Number(rows.find((r) => r.vertical === v.slug && r.category === c)?.n ?? 0) })),
    }));
  });
}
