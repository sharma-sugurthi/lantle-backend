/**
 * One-time import of the review markdown into Postgres.
 *
 *   npm run import                       # imports seed/tools/*.md with seed/thumbnails/*.webp (all 63 reviews)
 *   npm run import -- /path/to/seo-tool  # imports a site checkout's src/content/tools and public/tools instead
 *   add --keep-local-thumbnails to skip Storage and keep /tools/<slug>.webp paths (local testing only)
 *
 * Every tool is upserted by slug as published, so it is safe to run again.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { pool, q, migrate } from '../src/db.js';
import { uploadThumbnail, storageConfigured } from '../src/lib/storage.js';
import { isValidCategory } from '../src/taxonomy.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keepLocal = process.argv.includes('--keep-local-thumbnails');
const root = process.cwd();
const dir = args[0] ? path.join(args[0], 'src/content/tools') : path.join(root, 'seed/tools');
const thumbsDir = args[0] ? path.join(args[0], 'public/tools') : path.join(root, 'seed/thumbnails');
if (!fs.existsSync(dir)) {
  console.error(`No markdown folder at ${dir}`);
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
if (!keepLocal && !storageConfigured()) {
  console.error('Supabase Storage is not configured, so thumbnails cannot be uploaded. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --keep-local-thumbnails for a local test.');
  process.exit(1);
}

await migrate();
let n = 0;
for (const f of files) {
  const slug = f.replace(/\.md$/, '');
  const { data, content } = matter(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!isValidCategory(String(data.vertical), String(data.category))) {
    console.error(`skip ${slug}: category "${data.category}" is not in vertical "${data.vertical}"`);
    continue;
  }
  let thumbnail: string | null = null;
  const local = path.join(thumbsDir, `${slug}.webp`);
  if (fs.existsSync(local)) thumbnail = keepLocal ? `/tools/${slug}.webp` : await uploadThumbnail(slug, fs.readFileSync(local));
  const added = new Date(data.addedDate);
  const featured = data.featured === true;
  const paidUntil = featured ? new Date(added.getTime() + 365 * 86400_000) : null;
  await q(
    `insert into tools (slug, name, website, tagline, vertical, category, pricing, best_for, rating, editors_pick, thumbnail_url, body_md, status, plan, paid_until, added_at, published_at, live_notified_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'published',$13,$14,$15,$15,$15)
     on conflict (slug) do update set name=excluded.name, website=excluded.website, tagline=excluded.tagline, vertical=excluded.vertical, category=excluded.category,
       pricing=excluded.pricing, best_for=excluded.best_for, rating=excluded.rating, editors_pick=excluded.editors_pick,
       thumbnail_url=coalesce(excluded.thumbnail_url, tools.thumbnail_url), body_md=excluded.body_md, plan=excluded.plan, paid_until=excluded.paid_until, added_at=excluded.added_at, updated_at=now()`,
    [slug, data.name, data.website, data.tagline, data.vertical, data.category, data.pricing, data.bestFor ?? '', data.rating ?? null, data.editorsPick === true,
      thumbnail, content.trim() + '\n', featured ? 'featured' : 'basic', paidUntil, added],
  );
  n++;
  console.log(`imported ${slug}${thumbnail ? '' : ' (no thumbnail)'}`);
}
console.log(`done: ${n} of ${files.length} tools`);
await pool.end();
