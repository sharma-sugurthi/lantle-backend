import type { FastifyInstance } from 'fastify';
import { q } from '../db.js';
import { verifyWebhook } from '../lib/dodo.js';
import { boss, Q } from '../queue.js';

/**
 * Payment webhooks. Verified, stored once by id, acknowledged immediately, processed by the queue.
 * Registered as its own plugin so the raw-body JSON parser does not leak into the rest of the app.
 */
export default async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/dodo', { config: { rateLimit: false } }, async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    let payload: any;
    try {
      payload = verifyWebhook(raw, req.headers as Record<string, string | string[] | undefined>);
    } catch (e) {
      req.log.warn({ err: e }, 'webhook rejected');
      return reply.code(400).send({ error: 'invalid signature' });
    }
    const headerId = req.headers['webhook-id'];
    const id = String(Array.isArray(headerId) ? headerId[0] : headerId ?? `${payload?.type}:${payload?.data?.payment_id ?? Date.now()}`);
    const type = String(payload?.type ?? 'unknown');
    const { rowCount } = await q(
      'insert into webhook_events (id, provider, type, payload) values ($1, $2, $3, $4) on conflict (id) do nothing',
      [id, 'dodo', type, payload],
    );
    if (rowCount) await boss.send(Q.payments, { eventId: id });
    return { received: true };
  });
}
