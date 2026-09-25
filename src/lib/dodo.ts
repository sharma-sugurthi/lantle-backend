import { Webhook } from 'standardwebhooks';
import { config } from '../config.js';

/**
 * Dodo Payments REST client. Kept to two calls so any API change is a one-file fix.
 * Docs: https://docs.dodopayments.com (Checkout Sessions, Webhooks).
 */
const base = () => (config.dodo.mode === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com');

export type CartItem = { product_id: string; quantity: number };

export async function createCheckout(opts: {
  cart: CartItem[];
  email?: string;
  name?: string;
  returnUrl: string;
  metadata: Record<string, string>;
}): Promise<{ checkoutUrl: string; sessionId: string }> {
  if (!config.dodo.apiKey) throw new Error('Dodo Payments is not configured (DODO_API_KEY).');
  if (opts.cart.some((c) => !c.product_id)) throw new Error('A Dodo product id is missing. Set the DODO_PRODUCT_* env vars.');
  const body: Record<string, unknown> = {
    product_cart: opts.cart,
    return_url: opts.returnUrl,
    metadata: opts.metadata,
  };
  if (opts.email) body.customer = { email: opts.email, name: opts.name || undefined };
  const res = await fetch(`${base()}/checkouts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.dodo.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`Dodo checkout failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  const checkoutUrl = data.checkout_url ?? data.payment_link ?? data.url;
  if (!checkoutUrl) throw new Error(`Dodo checkout response had no checkout_url: ${JSON.stringify(data).slice(0, 300)}`);
  return { checkoutUrl, sessionId: data.session_id ?? data.id ?? '' };
}

/** Verifies a webhook using the Standard Webhooks signature scheme Dodo uses. Throws when invalid. */
export function verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): unknown {
  if (!config.dodo.webhookSecret) throw new Error('DODO_WEBHOOK_SECRET is not set.');
  const pick = (k: string) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const wh = new Webhook(config.dodo.webhookSecret);
  return wh.verify(rawBody, {
    'webhook-id': pick('webhook-id') ?? '',
    'webhook-signature': pick('webhook-signature') ?? '',
    'webhook-timestamp': pick('webhook-timestamp') ?? '',
  });
}

export const paymentsConfigured = (): boolean => Boolean(config.dodo.apiKey);
