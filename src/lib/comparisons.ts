import { renderMarkdown } from './markdown.js';
import { q } from '../db.js';
import { dateOnly } from './tools.js';

export type ComparisonRow = {
  id: string; tool_a: string; tool_b: string; verdict_md: string; pick_a_if: string[]; pick_b_if: string[];
  winner: string | null; winner_reason: string | null; status: 'draft' | 'published'; reviewed_at: Date | string | null;
  created_at: Date; updated_at: Date;
};

/** Slugs in the stored order (tool_a < tool_b) so a pair has exactly one row whichever way it was typed. */
export const orderPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export function comparisonToApi(c: ComparisonRow) {
  return {
    toolA: c.tool_a,
    toolB: c.tool_b,
    verdictHtml: renderMarkdown(c.verdict_md),
    verdict: c.verdict_md,
    pickAIf: c.pick_a_if ?? [],
    pickBIf: c.pick_b_if ?? [],
    winner: c.winner ?? undefined,
    winnerReason: c.winner_reason ?? undefined,
    reviewedAt: c.reviewed_at ? dateOnly(c.reviewed_at) : undefined,
  };
}

export const getComparison = async (id: string): Promise<ComparisonRow | null> =>
  (await q<ComparisonRow>('select * from comparisons where id::text = $1', [id])).rows[0] ?? null;

export async function allComparisons(): Promise<ComparisonRow[]> {
  return (await q<ComparisonRow>('select * from comparisons order by tool_a, tool_b')).rows;
}

/** Only rows whose both tools are published make it to the API, so a verdict never references a page that does not exist. */
export async function publishedComparisons(): Promise<ComparisonRow[]> {
  return (await q<ComparisonRow>(
    `select c.* from comparisons c
       join tools a on a.slug = c.tool_a and a.status = 'published'
       join tools b on b.slug = c.tool_b and b.status = 'published'
     where c.status = 'published' order by c.tool_a, c.tool_b`,
  )).rows;
}

export type ComparisonInput = Pick<ComparisonRow, 'verdict_md' | 'pick_a_if' | 'pick_b_if' | 'winner' | 'winner_reason' | 'status'> & { reviewed_at: string | null };

export async function upsertComparison(a: string, b: string, c: ComparisonInput): Promise<ComparisonRow> {
  const [ta, tb] = orderPair(a, b);
  const winner = c.winner === ta || c.winner === tb ? c.winner : null;
  return (await q<ComparisonRow>(
    `insert into comparisons (tool_a, tool_b, verdict_md, pick_a_if, pick_b_if, winner, winner_reason, status, reviewed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (tool_a, tool_b) do update set verdict_md=excluded.verdict_md, pick_a_if=excluded.pick_a_if, pick_b_if=excluded.pick_b_if,
       winner=excluded.winner, winner_reason=excluded.winner_reason, status=excluded.status, reviewed_at=excluded.reviewed_at, updated_at=now()
     returning *`,
    [ta, tb, c.verdict_md, c.pick_a_if, c.pick_b_if, winner, winner ? c.winner_reason : null, c.status, c.reviewed_at],
  )).rows[0];
}
