/**
 * One-time import of the review markdown into Postgres.
 *
 *   npm run import                       # imports seed/tools (63 reviews) and seed/posts (5 articles) with their images
 *   npm run import -- /path/to/seo-tool  # imports a site checkout's src/content/tools and public/tools instead
 *   add --keep-local-thumbnails to skip Storage and keep /tools/<slug>.webp paths (local testing only)
 *
 * Every tool is upserted by slug as published, so it is safe to run again.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { pool, q, migrate } from '../src/db.js';
import { uploadFile, uploadThumbnail, storageConfigured } from '../src/lib/storage.js';
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

// ---- blog posts ----
const postsDir = args[0] ? path.join(args[0], 'src/content/blog') : path.join(root, 'seed/posts');
const postThumbs = args[0] ? path.join(args[0], 'public') : path.join(root, 'seed/post-thumbnails');
if (fs.existsSync(postsDir)) {
  const postFiles = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md')).sort();
  let m = 0;
  for (const f of postFiles) {
    const slug = f.replace(/\.md$/, '');
    const { data, content } = matter(fs.readFileSync(path.join(postsDir, f), 'utf8'));
    let thumbnail: string | null = null;
    if (typeof data.thumbnail === 'string') {
      const local = args[0] ? path.join(postThumbs, data.thumbnail) : path.join(postThumbs, path.basename(data.thumbnail));
      if (keepLocal) thumbnail = data.thumbnail;
      else if (fs.existsSync(local)) {
        const ext = path.extname(local).slice(1).toLowerCase();
        thumbnail = await uploadFile(`posts/${slug}.${ext}`, fs.readFileSync(local), ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/webp');
      }
    }
    const pub = new Date(data.pubDate);
    await q(
      `insert into posts (slug, title, description, body_md, author, author_bio, tags, thumbnail_url, kind, status, pub_date, updated_date, published_at, live_notified_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10,$11,$10,$10)
       on conflict (slug) do update set title=excluded.title, description=excluded.description, body_md=excluded.body_md, author=excluded.author, author_bio=excluded.author_bio,
         tags=excluded.tags, thumbnail_url=coalesce(excluded.thumbnail_url, posts.thumbnail_url), kind=excluded.kind, pub_date=excluded.pub_date, updated_date=excluded.updated_date, updated_at=now()`,
      [slug, data.title, data.description ?? '', content.trim() + '\n', data.author ?? 'Lantle Editorial', data.authorBio ?? null, data.tags ?? [], thumbnail,
        data.sponsored === true ? 'sponsored' : 'editorial', pub, data.updatedDate ? new Date(data.updatedDate) : null],
    );
    m++;
    console.log(`imported post ${slug}${thumbnail ? '' : ' (no image)'}`);
  }
  console.log(`done: ${m} of ${postFiles.length} posts`);
}
await pool.end();
