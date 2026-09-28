import { config } from '../config.js';
import { esc } from './text.js';

const css = `
:root{--bg:#f6f8f6;--surface:#fff;--text:#111c18;--text-2:#3d4f47;--muted:#566058;--border:#d8e2dc;--accent:#156b52;--accent-soft:#e6f3ee;--warn-soft:#fdf7e3;--warn-border:#e8d48a;--danger:#a23b2c;--r:12px}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 Inter,ui-sans-serif,system-ui,sans-serif;color:var(--text);background:var(--bg)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--surface);border-bottom:1px solid var(--border)}header .wrap{display:flex;align-items:center;gap:1.25rem;flex-wrap:wrap}
header strong{font-size:1.05rem}header nav a{padding:.35rem .6rem;border-radius:8px;color:var(--text-2);font-size:.92rem}header nav a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.wrap{max-width:1120px;margin:0 auto;padding:.9rem 1.25rem}main.wrap{padding-top:1.5rem;padding-bottom:3rem}main.narrow{max-width:760px}
h1{font-size:1.5rem;margin:0 0 1rem}h2{font-size:1.1rem;margin:1.75rem 0 .75rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:1.1rem 1.25rem}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
th,td{text-align:left;padding:.6rem .8rem;border-bottom:1px solid var(--border);vertical-align:top;font-size:.9rem}th{font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-2);background:#f0f4f1}tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:.12rem .55rem;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:.74rem;font-weight:600}
.pill.warn{background:var(--warn-soft);color:var(--text-2);border:1px solid var(--warn-border)}.pill.grey{background:#eef1ef;color:var(--text-2)}.pill.bad{background:#f8e7e3;color:var(--danger)}
.btn{display:inline-block;padding:.5rem 1rem;border-radius:999px;background:var(--accent);color:#fff;border:0;font-weight:600;font-size:.9rem;cursor:pointer}.btn:hover{text-decoration:none;filter:brightness(.95)}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--border)}.btn.danger{background:var(--danger)}.btn.sm{padding:.3rem .7rem;font-size:.8rem}
form.stack{display:grid;gap:.85rem}label{display:grid;gap:.3rem;font-weight:600;font-size:.88rem}label small{font-weight:400;color:var(--muted)}
input,select,textarea{font:inherit;padding:.55rem .7rem;border:1px solid var(--border);border-radius:9px;background:#fff;width:100%}textarea{min-height:8rem;resize:vertical}
.row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}.muted{color:var(--muted)}.meta{font-size:.82rem;color:var(--muted)}
.flash{padding:.75rem 1rem;border-radius:10px;background:var(--accent-soft);color:var(--accent);margin-bottom:1rem;font-weight:500}.flash.err{background:#f8e7e3;color:var(--danger)}
.notice{padding:.85rem 1rem;border-radius:10px;background:var(--warn-soft);border:1px solid var(--warn-border);margin-bottom:1rem}
.two{display:grid;gap:1.5rem;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}@media(max-width:900px){.two{grid-template-columns:1fr}}
.tool-card{border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:#fff;max-width:360px}.tool-card img{display:block;width:100%;aspect-ratio:1200/534;object-fit:cover;background:#eef1ef}.tool-card .ph{aspect-ratio:1200/534;display:grid;place-items:center;background:linear-gradient(135deg,#e6f3ee,#f0f4f1);color:#2e9171;font-size:2.2rem;font-weight:700}
.tool-card .in{padding:.9rem 1.1rem 1.1rem}.tool-card h3{margin:.4rem 0 .2rem;font-size:1.05rem}.stars{color:#d4a017;letter-spacing:.05em}
.post-card{border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:#fff;max-width:360px}.post-card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#eef1ef}.post-card .in{padding:.9rem 1.1rem 1.1rem}
.prose{max-width:44rem}.prose h2{font-size:1.15rem;margin:1.4rem 0 .4rem}.prose p{margin:0 0 .9rem}.prose a{text-decoration:underline}.prose img{max-width:100%}
.chks{display:flex;flex-wrap:wrap;gap:.3rem .9rem;margin-top:.3rem}label.chk{display:inline-flex;align-items:center;gap:.35rem;font-weight:400;font-size:.86rem}label.chk input{width:auto}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;font-size:.9rem}.kv dt{color:var(--muted)}.kv dd{margin:0}
pre{white-space:pre-wrap;word-break:break-word;font-size:.8rem;background:#f0f4f1;padding:.6rem;border-radius:8px}
`;

const TABS: [string, string][] = [
  ['queue', 'Queue'], ['articles', 'Articles'], ['published', 'Published tools'], ['rejected', 'Rejected tools'],
  ['comparisons', 'Comparisons'], ['orders', 'Orders'], ['messages', 'Messages'], ['subscribers', 'Subscribers'], ['jobs', 'Jobs'],
];

export function layout(title: string, body: string, opts: { tab?: string; flash?: string; flashKind?: 'ok' | 'err'; nav?: boolean } = {}): string {
  const nav = opts.nav === false ? '' : `<nav>${TABS.map(([k, l]) => `<a href="/admin?tab=${k}" class="${opts.tab === k ? 'on' : ''}">${l}</a>`).join('')}<a href="${esc(config.siteUrl)}" target="_blank" rel="noopener">Site</a></nav>
    <form method="post" action="/admin/logout" style="margin-left:auto"><button class="btn ghost sm" type="submit">Log out</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ${esc(config.siteName)} admin</title><style>${css}</style></head>
<body><header><div class="wrap"><strong>${esc(config.siteName)} admin</strong>${nav}</div></header>
<main class="wrap">${opts.flash ? `<div class="flash ${opts.flashKind === 'err' ? 'err' : ''}">${esc(opts.flash)}</div>` : ''}${body}</main></body></html>`;
}

/** Pages a submitter sees (the private edit link). Same look, no admin navigation. */
export function publicLayout(title: string, body: string, opts: { flash?: string; flashKind?: 'ok' | 'err' } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ${esc(config.siteName)}</title><style>${css}</style></head>
<body><header><div class="wrap"><a href="${esc(config.siteUrl)}" style="color:var(--accent)"><strong>${esc(config.siteName)}</strong></a><span class="meta">Your submission</span></div></header>
<main class="wrap narrow">${opts.flash ? `<div class="flash ${opts.flashKind === 'err' ? 'err' : ''}">${esc(opts.flash)}</div>` : ''}${body}</main></body></html>`;
}

export const stars = (n: number | string | null | undefined): string => {
  const v = Math.round(Number(n) || 0);
  return v ? `<span class="stars">${'★'.repeat(v)}${'☆'.repeat(5 - v)}</span>` : '';
};

export const statusPill = (s: string): string => {
  const label = s.replace('_', ' ');
  const cls = s === 'published' || s === 'paid' || s === 'completed' ? '' : s === 'rejected' || s === 'failed' || s === 'refunded' ? 'bad' : s === 'pending' || s === 'changes_requested' ? 'warn' : 'grey';
  return `<span class="pill ${cls}">${esc(label)}</span>`;
};
