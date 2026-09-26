import { q } from '../db.js';

export type ToolRow = {
  id: string; slug: string; name: string; website: string; tagline: string; vertical: string; category: string;
  pricing: string; best_for: string; rating: number | string | null; editors_pick: boolean; thumbnail_url: string | null;
  body_md: string; status: string; plan: string; paid_until: Date | null; submitter_email: string | null;
  submitter_name: string | null; notes: string | null; reject_reason: string | null; review_note: string | null; edit_token: string | null; added_at: Date;
  published_at: Date | null; live_notified_at: Date | null; reminder_sent_at: Date | null; updated_at: Date;
};

export const isFeatured = (t: Pick<ToolRow, 'plan' | 'paid_until'>, now = new Date()): boolean =>
  t.plan === 'featured' && !!t.paid_until && new Date(t.paid_until) > now;

/** Shape the site's content loader consumes. Field names match the Astro schema. */
export function toApi(t: ToolRow) {
  return {
    slug: t.slug,
    name: t.name,
    website: t.website,
    tagline: t.tagline,
    vertical: t.vertical,
    category: t.category,
    pricing: t.pricing,
    bestFor: t.best_for,
    // numeric columns arrive as strings from pg
    rating: t.rating == null ? undefined : Number(t.rating),
    featured: isFeatured(t),
    featuredUntil: isFeatured(t) ? t.paid_until : undefined,
    editorsPick: t.editors_pick,
    thumbnail: t.thumbnail_url ?? undefined,
    addedDate: t.added_at,
    body: t.body_md,
  };
}

export const getTool = async (id: string): Promise<ToolRow | null> => (await q<ToolRow>('select * from tools where id = $1', [id])).rows[0] ?? null;

export async function publishedTools(): Promise<ToolRow[]> {
  return (await q<ToolRow>("select * from tools where status = 'published' order by added_at desc")).rows;
}

/** Extends a featured term: from today if lapsed, from the current end if still active. */
export async function grantFeatured(toolId: string, days: number): Promise<void> {
  await q(
    `update tools set plan = 'featured', reminder_sent_at = null, updated_at = now(),
       paid_until = greatest(coalesce(paid_until, now()), now()) + make_interval(days => $2)
     where id = $1`,
    [toolId, days],
  );
}

export async function revokeFeatured(toolId: string): Promise<void> {
  await q("update tools set plan = 'basic', paid_until = null, updated_at = now() where id = $1", [toolId]);
}
