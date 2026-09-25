import { Resend } from 'resend';
import { config } from '../config.js';
import { esc, money } from './text.js';

let resend: Resend | null = null;

export type Mail = { to: string; subject: string; text: string };

/**
 * Sends through Resend. Until the sending domain is verified, Resend only accepts mail to the account owner,
 * so anything addressed elsewhere is logged and skipped rather than failing the job.
 */
export async function sendMail(mail: Mail): Promise<'sent' | 'skipped' | 'logged'> {
  const to = mail.to.trim().toLowerCase();
  if (!config.email.domainVerified && to !== config.email.owner.toLowerCase()) {
    console.log(`[email] skipped (domain not verified) to=${to} subject="${mail.subject}"`);
    return 'skipped';
  }
  if (!config.email.resendKey) {
    console.log(`[email] RESEND_API_KEY not set. Would send to=${to} subject="${mail.subject}"\n${mail.text}`);
    return 'logged';
  }
  resend ??= new Resend(config.email.resendKey);
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#111c18;max-width:36rem">${mail.text
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 1em">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('')}<p style="margin:2em 0 0;color:#566058;font-size:13px">${esc(config.siteName)} · ${esc(config.siteUrl)}</p></div>`;
  const { error } = await resend.emails.send({ from: `${config.siteName} <${config.email.from}>`, to, subject: mail.subject, text: mail.text, html });
  if (error) throw new Error(`Resend error: ${error.message}`);
  return 'sent';
}

const site = () => config.siteName;
const sign = () => `\n\n${config.siteName}\n${config.siteUrl}`;

export const templates = {
  submissionReceived: (d: { to: string; name: string; toolName: string; plan: string }): Mail => ({
    to: d.to,
    subject: `We received ${d.toolName}`,
    text: `Hi ${d.name || 'there'},\n\nThanks for submitting ${d.toolName} to ${site()}. A person reads every submission, usually within five business days. You will get another email when the listing is live, or a short note if we need something changed.${d.plan === 'featured' ? '\n\nYour featured placement is confirmed and will switch on the moment the listing is approved.' : ''}${sign()}`,
  }),
  orderPaid: (d: { to: string; name: string; what: string; amountCents: number; currency: string; next: string }): Mail => ({
    to: d.to,
    subject: `Payment received: ${d.what}`,
    text: `Hi ${d.name || 'there'},\n\nPayment of ${money(d.amountCents, d.currency)} for ${d.what} has gone through. Your card statement and tax receipt come from Dodo Payments, our payment provider.\n\nWhat happens next: ${d.next}\n\nQuestions or a change of mind: reply to this email.${sign()}`,
  }),
  listingLive: (d: { to: string; name: string; toolName: string; url: string; featured: boolean }): Mail => ({
    to: d.to,
    subject: `${d.toolName} is live on ${site()}`,
    text: `Hi ${d.name || 'there'},\n\n${d.toolName} is now listed:\n${d.url}\n\n${d.featured ? 'It is pinned to the top of its category with a dofollow link for the next twelve months.' : 'This is a free basic listing with a nofollow link. Featured placement (dofollow link, pinned to the top of the category) is available any time from the submit page.'}\n\nYou can add a "listed on ${site()}" badge to your site from ${config.siteUrl}/badge/. If anything on the page is wrong, reply and we will fix it.${sign()}`,
  }),
  rejected: (d: { to: string; name: string; toolName: string; reason: string }): Mail => ({
    to: d.to,
    subject: `About your submission of ${d.toolName}`,
    text: `Hi ${d.name || 'there'},\n\nWe are not able to list ${d.toolName} at the moment. The reason: ${d.reason}\n\nIf that can be fixed, submit again and mention this email. Payments for featured placement, if any, are refunded in full.${sign()}`,
  }),
  featuredExpiring: (d: { to: string; name: string; toolName: string; until: string; renewUrl: string }): Mail => ({
    to: d.to,
    subject: `${d.toolName}: featured placement ends ${d.until}`,
    text: `Hi ${d.name || 'there'},\n\nThe featured placement for ${d.toolName} on ${site()} ends on ${d.until}. After that the listing stays live as a free basic listing (nofollow link, normal position).\n\nTo keep it pinned with a dofollow link for another year:\n${d.renewUrl}${sign()}`,
  }),
  ownerNew: (d: { subject: string; lines: string[]; adminUrl: string }): Mail => ({
    to: config.email.owner,
    subject: `[${site()}] ${d.subject}`,
    text: `${d.lines.join('\n')}\n\nOpen in admin: ${d.adminUrl}`,
  }),
  ownerJobFailed: (d: { queue: string; error: string; data: unknown }): Mail => ({
    to: config.email.owner,
    subject: `[${site()}] job failed: ${d.queue}`,
    text: `A background job failed after all retries.\n\nQueue: ${d.queue}\nError: ${d.error}\nData: ${JSON.stringify(d.data)}\n\nRetry it from ${config.siteUrl.includes('localhost') ? 'http://localhost:' + config.port : ''}/admin?tab=jobs`,
  }),
};
