import { esc } from './text.js';
import type { ComparisonFields } from './tools.js';
import { COMPANY_SIZES, DEPLOYMENTS, FEATURES, PLATFORMS } from '../taxonomy.js';

/** Comparison fields for the submit form (site) and the private edit page. `t` is empty on a fresh submission. */
export function comparisonFields(vertical: string, t: Partial<ComparisonFields> = {}, admin = false): string {
  const check = (name: string, opts: readonly string[], on: string[]) => opts.map((o) => `<label class="chk"><input type="checkbox" name="${name}" value="${esc(o)}" ${on.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('');
  const feats = FEATURES[vertical] ?? [];
  return `<fieldset class="stack" style="border:1px solid var(--border);border-radius:10px;padding:1rem"><legend style="font-weight:600;padding:0 .4rem">Comparison data <small class="muted" style="font-weight:400">${admin ? '(drives the vs and alternatives pages; a cross in the feature matrix means the box is unticked)' : '(shown on the "vs" and "alternatives" pages; be accurate, a person checks it)'}</small></legend>
    <div class="two"><label>Pros <small>one per line, 3 to 5, specific and checkable</small><textarea name="pros" rows="5">${esc((t.pros ?? []).join('\n'))}</textarea></label>
    <label>Cons <small>one per line, 2 to 4, honest limits</small><textarea name="cons" rows="5">${esc((t.cons ?? []).join('\n'))}</textarea></label></div>
    <div><span style="font-weight:600;font-size:.88rem">Features it has</span> <small class="muted">tick only what exists today</small><div class="chks" id="feat-box">${check('key_features', feats, t.key_features ?? [])}</div></div>
    <div><span style="font-weight:600;font-size:.88rem">Platforms</span><div class="chks">${check('platforms', PLATFORMS, t.platforms ?? [])}</div></div>
    <label>Native integrations <small>comma separated, up to 10 product names</small><input name="integrations" value="${esc((t.integrations ?? []).join(', '))}"></label>
    <div class="two"><label>Starting price <small>cheapest paid plan, e.g. $20 per user per month; leave empty if quote only</small><input name="starting_price" value="${esc(t.starting_price ?? '')}" maxlength="60"></label>
    <label>Free trial <small>days, 0 for none</small><input name="trial_days" type="number" min="0" max="365" value="${t.trial_days ?? ''}"></label></div>
    <div class="two"><label>Permanent free plan <select name="free_tier"><option value="">not sure</option><option value="yes" ${t.free_tier === true ? 'selected' : ''}>yes</option><option value="no" ${t.free_tier === false ? 'selected' : ''}>no</option></select></label>
    <label>Deployment <select name="deployment"><option value="">not sure</option>${DEPLOYMENTS.map((d) => `<option value="${d}" ${t.deployment === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label></div>
    <div><span style="font-weight:600;font-size:.88rem">Company size it fits</span><div class="chks">${check('company_size', COMPANY_SIZES, t.company_size ?? [])}</div></div>
    <label>Verdict line <small>one sentence starting "Pick &lt;name&gt; if", max 160 characters</small><input name="verdict_line" value="${esc(t.verdict_line ?? '')}" maxlength="160"></label>
  </fieldset>
  <fieldset class="stack" style="border:1px solid var(--border);border-radius:10px;padding:1rem"><legend style="font-weight:600;padding:0 .4rem">Deal <small class="muted" style="font-weight:400">(optional; one live discount, shown on the tool page, its category and in the API; never a ranking input)</small></legend>
    <label>Offer <small>e.g. "20% off the first year for Lantle readers", max 120 characters; empty removes the deal</small><input name="deal_text" value="${esc(t.deal_text ?? '')}" maxlength="120"></label>
    <div class="two"><label>Code <small>optional</small><input name="deal_code" value="${esc(t.deal_code ?? '')}" maxlength="40"></label>
    <label>Ends <small>optional, the deal disappears the day after</small><input name="deal_until" type="date" value="${esc(typeof t.deal_until === 'string' ? t.deal_until : t.deal_until ? new Date(t.deal_until).toISOString().slice(0, 10) : '')}"></label></div>
    <label>Landing page <small>https URL where the offer applies; defaults to the website</small><input name="deal_url" type="url" value="${esc(t.deal_url ?? '')}" maxlength="300"></label>
  </fieldset>`;
}

