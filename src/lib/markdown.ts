import { marked, type Tokens } from 'marked';

/**
 * Markdown to HTML for text that submitters wrote. `clean()` already strips raw tags on the way in; this closes the other
 * hole, javascript:/data: URLs in links and images, and removes any script-bearing element or inline handler that could
 * survive, so a crafted listing can never run code in the admin or on the site.
 */
const SAFE_PROTO = /^(https?:|mailto:|\/|#)/i;
const sanitiseHref = (href: string | null | undefined): string => {
  const h = (href ?? '').trim();
  return SAFE_PROTO.test(h) ? h : '#';
};

marked.use({
  walkTokens(token) {
    if (token.type === 'link') (token as Tokens.Link).href = sanitiseHref((token as Tokens.Link).href);
    if (token.type === 'image') (token as Tokens.Image).href = sanitiseHref((token as Tokens.Image).href);
  },
});

export function renderMarkdown(md: string): string {
  const html = marked.parse(md ?? '', { async: false }) as string;
  return html
    .replace(/<\/?(script|iframe|object|embed|style|form|svg|math|base|meta|link)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*"(?!https?:|mailto:|\/|#)[^"]*"/gi, '$1="#"');
}
