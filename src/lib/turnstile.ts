import { config } from '../config.js';

/** Returns true when the token is valid, or when Turnstile is not configured (local dev). */
export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (!config.turnstileSecret) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: config.turnstileSecret, response: token, remoteip: ip }),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
