import { Resend } from 'resend';
import { config } from '../config.js';
import { esc, fmtDate, money } from './text.js';
import dns from 'node:dns/promises';

/**
 * Every email is one structured object rendered by one layout, so they all look the same:
 * wordmark bar, white card with heading and paragraphs, optional details table, one button, quiet footer.
 * Table based HTML with inline styles for mail clients, plus a plain text alternative.
 */
export type Mail = {
  to: string;
  subject: string;
  preheader?: string;
  heading: string;
  paragraphs: string[];
  details?: [string, string][];
  cta?: { label: string; url: string };
  note?: string;
  reason?: string;
};

let resend: Resend | null = null;

export async function sendMail(mail: Mail): Promise<'sent' | 'skipped' | 'logged'> {
  const to = mail.to.trim().toLowerCase();
  if (!config.email.domainVerified && to !== config.email.owner.toLowerCase()) {
    console.log(`[email] skipped (domain not verified) to=${to} subject="${mail.subject}"`);
    return 'skipped';
  }
  if (!config.email.resendKey) {
    console.log(`[email] RESEND_API_KEY not set. Would send to=${to} subject="${mail.subject}"\n${renderText(mail)}`);
    return 'logged';
  }
  resend ??= new Resend(config.email.resendKey);
  const { error } = await resend.emails.send({
    from: `${config.siteName} <${config.email.from}>`,
    to,
    subject: mail.subject,
    text: renderText(mail),
    html: renderHtml(mail),
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
  return 'sent';
}

const C = { bg: '#f6f8f6', card: '#ffffff', text: '#111c18', muted: '#566058', accent: '#156b52', border: '#d8e2dc', soft: '#e6f3ee', warn: '#fdf7e3', warnBorder: '#e8d48a' };
const font = "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

export function renderHtml(m: Mail): string {
  const p = (t: string) => `<p style="margin:0 0 14px;${font}font-size:15px;line-height:1.6;color:${C.text}">${esc(t).replace(/\n/g, '<br>')}</p>`;
  const details = m.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:6px 0 18px;border:1px solid ${C.border};border-radius:10px;border-collapse:separate;overflow:hidden">
        ${m.details.map(([k, v], i) => `<tr><td style="padding:9px 14px;${font}font-size:13px;color:${C.muted};background:${i % 2 ? C.card : '#f0f4f1'};width:38%;border-bottom:1px solid ${C.border}">${esc(k)}</td><td style="padding:9px 14px;${font}font-size:14px;color:${C.text};background:${i % 2 ? C.card : '#f0f4f1'};border-bottom:1px solid ${C.border}">${esc(v)}</td></tr>`).join('')}
      </table>`
    : '';
  const reason = m.reason
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px"><tr><td style="padding:12px 14px;background:${C.warn};border:1px solid ${C.warnBorder};border-radius:10px;${font}font-size:14px;line-height:1.55;color:${C.text}">${esc(m.reason).replace(/\n/g, '<br>')}</td></tr></table>`
    : '';
  const cta = m.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td style="background:${C.accent};border-radius:999px"><a href="${esc(m.cta.url)}" style="display:inline-block;padding:11px 22px;${font}font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${esc(m.cta.label)}</a></td></tr></table>
       <p style="margin:0 0 18px;${font}font-size:12px;color:${C.muted}">Or copy this link: <a href="${esc(m.cta.url)}" style="color:${C.accent}">${esc(m.cta.url)}</a></p>`
    : '';
  const note = m.note ? `<p style="margin:0;${font}font-size:13px;line-height:1.55;color:${C.muted}">${esc(m.note)}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(m.preheader ?? m.heading)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.bg}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px">
  <tr><td style="padding:0 6px 14px"><a href="${esc(config.siteUrl)}" style="${font}font-size:18px;font-weight:800;color:${C.accent};text-decoration:none;letter-spacing:-0.3px">${esc(config.siteName)}</a></td></tr>
  <tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:28px 28px 16px">
    <h1 style="margin:0 0 16px;${font}font-size:21px;line-height:1.3;font-weight:700;color:${C.text}">${esc(m.heading)}</h1>
    ${m.paragraphs.map(p).join('')}
    ${reason}${details}${cta}${note}
  </td></tr>
  <tr><td style="padding:16px 6px 0;${font}font-size:12px;line-height:1.6;color:${C.muted}">
    ${esc(config.siteName)} · <a href="${esc(config.siteUrl)}" style="color:${C.muted}">${esc(config.siteUrl.replace(/^https?:\/\//, ''))}</a><br>
    You are receiving this because of a submission, order or subscription made with this email address. Reply to this email to reach a person.
  </td></tr>
</table></td></tr></table></body></html>`;
}

export function renderText(m: Mail): string {
  const lines: string[] = [m.heading, '', ...m.paragraphs.flatMap((p) => [p, ''])];
  if (m.reason) lines.push(m.reason, '');
  if (m.details?.length) lines.push(...m.details.map(([k, v]) => `${k}: ${v}`), '');
  if (m.cta) lines.push(`${m.cta.label}: ${m.cta.url}`, '');
  if (m.note) lines.push(m.note, '');
  lines.push(`${config.siteName} · ${config.siteUrl}`);
  return lines.join('\n');
}

const site = () => config.siteName;
const editLink = (token: string | null | undefined) => (token ? `${apiBase()}/s/${token}` : undefined);
export const apiBase = (): string => (process.env.API_BASE_URL ?? '').replace(/\/$/, '') || config.siteUrl;

/**
 * Check that the email domain has at least one MX record.
 * Returns true if MX records exist (domain can receive mail) or if the DNS lookup times out
 * (we don't want to block legitimate submissions on a slow DNS day).
 */
export async function checkEmailMx(email: string): Promise<boolean> {
  const domain = email.split('@')[1];
  if (!domain) return false;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return Array.isArray(records) && records.length > 0;
  } catch {
    // DNS timeout or NXDOMAIN - give benefit of the doubt on timeout, block on NXDOMAIN
    return false;
  }
}

export const templates = {
  // ---- tools ----
  toolReceived: (d: { to: string; name: string; toolName: string; plan: string; token?: string | null; complete?: boolean }): Mail => ({
    to: d.to,
    subject: `We received ${d.toolName}`,
    preheader: d.complete === false ? 'Complete the listing from the link inside.' : 'An editor reviews it within five business days.',
    heading: d.complete === false ? `${d.toolName}: complete your listing` : `${d.toolName} is in the review queue`,
    paragraphs: [
      `Hi ${d.name || 'there'},`,
      d.complete === false
        ? `${d.toolName} is registered. Use the link below to add the tagline, the description and a screenshot. The review starts the moment the listing is complete.`
        : `An editor reads every submission within five business days. You hear from us when ${d.toolName} is live, or with a short note if something needs changing first.`,
      ...(d.plan === 'featured' ? ['Featured placement switches on the moment the listing is approved: dofollow link, pinned to the top of its category for twelve months.'] : []),
    ],
    details: [['Tool', d.toolName], ['Plan', d.plan === 'featured' ? 'Featured listing' : 'Basic listing (free)'], ['Review time', 'Up to 5 business days']],
    cta: editLink(d.token) ? { label: d.complete === false ? 'Complete the listing' : 'View or edit the submission', url: editLink(d.token)! } : undefined,
    note: 'Keep this email. The link is private and lets you update the listing at any time, before or after it is live.',
  }),
  toolChangesRequested: (d: { to: string; name: string; toolName: string; note: string; token?: string | null }): Mail => ({
    to: d.to,
    subject: `${d.toolName}: one thing before we can list it`,
    preheader: 'A short note from the reviewer, and a link to update your submission.',
    heading: `We need a small change to ${d.toolName}`,
    paragraphs: [`Hi ${d.name || 'there'},`, `We reviewed ${d.toolName} and it is close. Before it goes live, please look at this:`],
    reason: d.note,
    cta: editLink(d.token) ? { label: 'Update the submission', url: editLink(d.token)! } : undefined,
    note: 'Once you save the update it goes straight back to the top of the review queue. Reply to this email if anything is unclear.',
  }),
  toolLive: (d: { to: string; name: string; toolName: string; url: string; featured: boolean; token?: string | null }): Mail => ({
    to: d.to,
    subject: `${d.toolName} is live on ${site()}`,
    preheader: 'Your listing is published. Here is the link and the badge.',
    heading: `${d.toolName} is live`,
    paragraphs: [
      `Hi ${d.name || 'there'},`,
      d.featured
        ? 'Your listing is published, pinned to the top of its category with a dofollow link for the next twelve months.'
        : 'Your free listing is published with a nofollow link. Featured placement (dofollow link, pinned to the top of the category) is available any time from the submit page.',
    ],
    details: [['Listing', d.url], ['Placement', d.featured ? 'Featured, 12 months' : 'Basic'], ['Badge', `${config.siteUrl}/badge/`]],
    cta: { label: 'See the listing', url: d.url },
    note: editLink(d.token) ? `Spotted a mistake? Update it here: ${editLink(d.token)}` : 'Spotted a mistake? Reply to this email.',
  }),
  /** Fires when a basic (free) listing goes live. Encourages the submitter to fill the Full Profile to unlock the sidebar and comparison pages. */
  toolBasicLive: (d: { to: string; name: string; toolName: string; url: string; token?: string | null }): Mail => ({
    to: d.to,
    subject: `${d.toolName} is live - unlock the full profile`,
    preheader: 'Your basic listing is published. Fill in the full profile to appear in comparisons and unlock the sidebar.',
    heading: `${d.toolName} is live`,
    paragraphs: [
      `Hi ${d.name || 'there'},`,
      `Your basic listing is published at the link below. It shows your tagline, screenshot, and pricing.`,
      `Fill in the full profile - where it shines, where it falls short, a conclusion, and the sidebar data - and ${site()} will add your tool to the "vs" and "alternatives" comparison pages automatically. It takes about 5 minutes.`,
    ],
    details: [['Listing', d.url], ['Placement', 'Basic (nofollow link)'], ['Badge', `${config.siteUrl}/badge/`]],
    cta: editLink(d.token) ? { label: 'Complete the full profile', url: editLink(d.token)! } : { label: 'See the listing', url: d.url },
    note: 'Keep this link - it is your private edit link for this listing.',
  }),
  toolRejected: (d: { to: string; name: string; toolName: string; reason: string }): Mail => ({
    to: d.to,
    subject: `About your submission of ${d.toolName}`,
    heading: `We could not list ${d.toolName}`,
    paragraphs: [`Hi ${d.name || 'there'},`, `We are not able to list ${d.toolName} at the moment. The reason:`],
    reason: d.reason,
    note: 'If that can be fixed, submit again and mention this email. Any payment for featured placement is refunded in full.',
  }),
  featuredExpiring: (d: { to: string; name: string; toolName: string; until: string; renewUrl: string }): Mail => ({
    to: d.to,
    subject: `${d.toolName}: featured placement ends ${d.until}`,
    heading: `Featured placement for ${d.toolName} ends soon`,
    paragraphs: [`Hi ${d.name || 'there'},`, `The featured placement ends on ${d.until}. After that the listing stays live as a free basic listing: nofollow link, normal position in the category.`],
    details: [['Tool', d.toolName], ['Featured until', d.until], ['Renewal', config.prices.featured.label]],
    cta: { label: 'Renew for another year', url: d.renewUrl },
  }),

  // ---- articles ----
  articleReceived: (d: { to: string; name: string; title: string; writtenByUs: boolean; token?: string | null; complete?: boolean }): Mail => ({
    to: d.to,
    subject: `We received your article: ${d.title}`,
    preheader: d.complete === false ? 'Add the title and draft from the link inside.' : 'A publication date follows within one business day.',
    heading: d.complete === false ? 'Your sponsored article: add the draft' : 'Your sponsored article is in the queue',
    paragraphs: [
      `Hi ${d.name || 'there'},`,
      d.complete === false
        ? (d.writtenByUs ? 'Use the link below to give us the angle, the product pages to link and anything we must include. We write the article and send you a draft to approve.' : 'Use the link below to add the title and the draft. The editor picks it up the moment it is in.')
        : d.writtenByUs
          ? 'We write the article from your pitch and send you a draft to approve before it is published.'
          : 'The editor reviews the draft, edits for clarity where needed, and confirms a publication date within one business day. Most articles are live within three business days.',
    ],
    details: [['Title', d.title], ['Writing', d.writtenByUs ? 'By us (+' + config.prices.writingAddon.label + ')' : 'Your draft'], ['Links', 'Up to 2 dofollow, rel="sponsored"']],
    cta: editLink(d.token) ? { label: d.complete === false ? 'Add the draft' : 'View or edit the draft', url: editLink(d.token)! } : undefined,
  }),
  articleChangesRequested: (d: { to: string; name: string; title: string; note: string; token?: string | null }): Mail => ({
    to: d.to,
    subject: `${d.title}: a note from the editor`,
    heading: 'One change before we publish',
    paragraphs: [`Hi ${d.name || 'there'},`, `We read "${d.title}" and have one request before it goes live:`],
    reason: d.note,
    cta: editLink(d.token) ? { label: 'Update the draft', url: editLink(d.token)! } : undefined,
    note: 'Saving the update sends it straight back to the editor. Reply to this email if you would rather discuss it.',
  }),
  articleLive: (d: { to: string; name: string; title: string; url: string }): Mail => ({
    to: d.to,
    subject: `Published: ${d.title}`,
    preheader: 'Your article is live and shared on LinkedIn.',
    heading: 'Your article is live',
    paragraphs: [`Hi ${d.name || 'there'},`, `"${d.title}" is published and indexed. It stays up permanently and we share it on LinkedIn this week.`],
    details: [['Article', d.url]],
    cta: { label: 'Read it live', url: d.url },
    note: 'Share it from your own channels too; the first week of traffic is what search engines notice.',
  }),
  articleRejected: (d: { to: string; name: string; title: string; reason: string }): Mail => ({
    to: d.to,
    subject: `About your article: ${d.title}`,
    heading: 'We could not publish this one',
    paragraphs: [`Hi ${d.name || 'there'},`, 'The reason from the editor:'],
    reason: d.reason,
    note: 'Any payment is refunded in full. If you would like to pitch a different angle, reply to this email.',
  }),
  submissionUpdated: (d: { to: string; name: string; what: string }): Mail => ({
    to: d.to,
    subject: `Update received: ${d.what}`,
    heading: 'Thanks, we have your update',
    paragraphs: [`Hi ${d.name || 'there'},`, `Your update to ${d.what} is back at the top of the review queue. We look at it within two business days.`],
  }),

  // ---- orders ----
  orderPaid: (d: { to: string; name: string; what: string; amountCents: number; currency: string; next: string; orderId: string; paidAt: Date; links?: [string, string][] }): Mail => ({
    to: d.to,
    subject: `Payment received: ${d.what}`,
    preheader: `${money(d.amountCents, d.currency)} received. ${d.links?.length ? 'Your private links are inside.' : 'Here is what happens next.'}`,
    heading: d.links?.length ? 'Paid. Now complete your listing' : 'Payment received',
    paragraphs: [`Hi ${d.name || 'there'},`, 'Your payment has gone through and the order is confirmed.', `What happens next: ${d.next}`],
    details: [['Order', d.what], ['Amount', money(d.amountCents, d.currency)], ['Date', fmtDate(d.paidAt)], ['Reference', d.orderId.slice(0, 8).toUpperCase()], ['Receipt', 'Sent separately by Dodo Payments'], ...(d.links ?? [])],
    cta: d.links?.length ? { label: d.links.length === 1 ? 'Complete it now' : 'Complete the first one', url: d.links[0][1] } : undefined,
    note: d.links?.length ? 'Each link is private to that item. Keep this email.' : 'Questions or a change of mind: reply to this email. Refunds are handled through the same provider.',
  }),

  // ---- owner ----
  ownerNew: (d: { subject: string; heading?: string; details: [string, string][]; body?: string; adminUrl: string }): Mail => ({
    to: config.email.owner,
    subject: `[${site()}] ${d.subject}`,
    heading: d.heading ?? d.subject,
    paragraphs: d.body ? [d.body] : [],
    details: d.details,
    cta: { label: 'Open in admin', url: d.adminUrl },
  }),
  ownerJobFailed: (d: { queue: string; error: string; data: unknown }): Mail => ({
    to: config.email.owner,
    subject: `[${site()}] background job failed: ${d.queue}`,
    heading: 'A background job failed after all retries',
    paragraphs: ['It will not retry on its own. Open the admin to retry it with one click.'],
    details: [['Queue', d.queue], ['Error', d.error], ['Data', JSON.stringify(d.data).slice(0, 400)]],
    cta: { label: 'Open failed jobs', url: `${apiBase()}/admin?tab=jobs` },
  }),
};
