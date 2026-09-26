import { q } from '../db.js';

export type PostRow = {
  id: string; slug: string; title: string; description: string; body_md: string; author: string; author_bio: string | null;
  tags: string[]; thumbnail_url: string | null; kind: 'editorial' | 'sponsored' | 'guest'; status: string; order_id: string | null;
  company: string | null; website: string | null; submitter_email: string | null; submitter_name: string | null;
  written_by_us: boolean; notes: string | null; review_note: string | null; reject_reason: string | null; edit_token: string | null;
  pub_date: Date; updated_date: Date | null; published_at: Date | null; live_notified_at: Date | null; created_at: Date; updated_at: Date;
};

/** Shape the site's blog loader consumes. Field names match the Astro blog schema. */
export function postToApi(p: PostRow) {
  return {
    slug: p.slug,
    title: p.title,
    description: p.description,
    pubDate: p.pub_date,
    updatedDate: p.updated_date ?? undefined,
    author: p.author,
    authorBio: p.author_bio ?? undefined,
    thumbnail: p.thumbnail_url ?? undefined,
    tags: p.tags,
    sponsored: p.kind === 'sponsored',
    body: p.body_md,
  };
}

export const getPost = async (id: string): Promise<PostRow | null> => (await q<PostRow>('select * from posts where id::text = $1', [id])).rows[0] ?? null;

export async function publishedPosts(): Promise<PostRow[]> {
  return (await q<PostRow>("select * from posts where status = 'published' order by pub_date desc")).rows;
}
