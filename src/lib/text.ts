import crypto from 'node:crypto';
import { q } from '../db.js';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Submitter text never carries HTML into the site. Strip tags, collapse whitespace, cap length. */
export const clean = (s: unknown, max = 5000): string =>
  String(s ?? '').replace(/<[^>]*>/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);

export const cleanLine = (s: unknown, max = 200): string => clean(s, max).replace(/\s+/g, ' ');

export const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

export const ipHash = (ip: string): string => crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'tool';
}

export async function uniqueSlug(base: string, table: 'tools' | 'posts' = 'tools'): Promise<string> {
  let slug = slugify(base);
  for (let i = 2; i < 100; i++) {
    const { rowCount } = await q(`select 1 from ${table} where slug = $1`, [slug]);
    if (!rowCount) return slug;
    slug = `${slugify(base)}-${i}`;
  }
  return `${slugify(base)}-${Date.now()}`;
}

export const newToken = (): string => crypto.randomBytes(24).toString('hex');

export const parseTags = (s: string): string[] => [...new Set(s.split(',').map((t) => cleanLine(t, 40)).filter(Boolean))].slice(0, 8);

/** Builds the review body from the four submission answers, in the same shape as an editorial review. */
export function bodyFromAnswers(name: string, a: { what: string; shines: string; short: string; conclusion: string }): string {
  const parts = [`## What is ${name}?`, '', a.what, '', '## Where it shines', '', a.shines, '', '## Where it falls short', '', a.short];
  if (a.conclusion) parts.push('', '## Conclusion', '', a.conclusion);
  return parts.join('\n') + '\n';
}

export const fmtDate = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

export const money = (cents: number, currency = 'USD'): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

/** One item per line (or comma separated when `commas` is set), trimmed, de-duplicated, capped. Used for pros, cons, platforms and integrations. */
export const lines = (s: string, max = 10, maxLen = 120, commas = false): string[] =>
  [...new Set(s.split(commas ? /[\n,]/ : /\r?\n/).map((x) => cleanLine(x, maxLen).replace(/^[-*•]\s*/, '').replace(/[.\s]+$/, '')).filter(Boolean))].slice(0, max);

/** Multi-value form fields arrive as a string (one box) or an array (several boxes). */
export const multi = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
