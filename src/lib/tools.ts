import { q } from '../db.js';
import { COMPANY_SIZES, DEPLOYMENTS, FEATURES, PLATFORMS } from '../taxonomy.js';

export type ToolRow = {
  id: string; slug: string; name: string; website: string; tagline: string; vertical: string; category: string;
  pricing: string; best_for: string; rating: number | string | null; editors_pick: boolean; thumbnail_url: string | null;
  body_md: string; status: string; plan: string; paid_until: Date | null; submitter_email: string | null;
  submitter_name: string | null; notes: string | null; reject_reason: string | null; review_note: string | null; edit_token: string | null; added_at: Date;
  published_at: Date | null; live_notified_at: Date | null; reminder_sent_at: Date | null; updated_at: Date;
  // comparison data (migration 003), all optional
  pros: string[]; cons: string[]; key_features: string[]; platforms: string[]; integrations: string[];
  starting_price: string | null; free_tier: boolean | null; trial_days: number | null; deployment: string | null;
  company_size: string[]; verdict_line: string | null; data_checked_at: Date | string | null;
  // false while a paid listing is waiting for the submitter to add the description (pay first, complete later)
  listing_complete: boolean;
};

export type ComparisonFields = Pick<ToolRow, 'pros' | 'cons' | 'key_features' | 'platforms' | 'integrations' | 'starting_price' | 'free_tier' | 'trial_days' | 'deployment' | 'company_size' | 'verdict_line'>;

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
    // comparison data; the site treats every one of these as optional
    pros: t.pros ?? [],
    cons: t.cons ?? [],
    keyFeatures: t.key_features ?? [],
    platforms: t.platforms ?? [],
    integrations: t.integrations ?? [],
    startingPrice: t.starting_price ?? undefined,
    freeTier: t.free_tier ?? undefined,
    trialDays: t.trial_days ?? undefined,
    deployment: t.deployment ?? undefined,
    companySize: t.company_size ?? [],
    verdictLine: t.verdict_line ?? undefined,
    dataCheckedAt: t.data_checked_at ? dateOnly(t.data_checked_at) : undefined,
  };
}

/** A date column arrives as a Date at local midnight; send it as YYYY-MM-DD so the site never shifts it by a timezone. */
export function dateOnly(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Writes the comparison columns. Validates against the taxonomy vocabulary so the matrix never shows a made-up feature. */
export async function saveComparisonFields(toolId: string, vertical: string, f: ComparisonFields, checked: boolean): Promise<void> {
  const vocab = new Set(FEATURES[vertical] ?? []);
  const features = f.key_features.filter((x) => vocab.has(x));
  const platforms = f.platforms.filter((x) => PLATFORMS.includes(x));
  const sizes = f.company_size.filter((x) => (COMPANY_SIZES as readonly string[]).includes(x));
  const deployment = f.deployment && (DEPLOYMENTS as readonly string[]).includes(f.deployment) ? f.deployment : null;
  await q(
    `update tools set pros=$2, cons=$3, key_features=$4, platforms=$5, integrations=$6, starting_price=$7, free_tier=$8, trial_days=$9, deployment=$10,
       company_size=$11, verdict_line=$12, data_checked_at=case when $13::boolean then current_date else data_checked_at end, updated_at=now() where id=$1`,
    [toolId, f.pros, f.cons, features, platforms, f.integrations, f.starting_price, f.free_tier, f.trial_days, deployment, sizes, f.verdict_line, checked],
  );
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
