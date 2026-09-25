import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { MAX_UPLOAD_BYTES } from './lib/storage.js';
import { startQueue, stopQueue } from './queue.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';
import webhookRoutes from './routes/webhooks.js';

export async function buildApp() {
  const app = Fastify({ logger: { level: config.isProd ? 'info' : 'debug' }, trustProxy: true, bodyLimit: 256 * 1024 });

  await app.register(cookie, { secret: config.admin.sessionSecret });
  await app.register(formbody);
  await app.register(multipart, { attachFieldsToBody: 'keyValues', limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 40, fieldSize: 64 * 1024 } });
  await app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : true,
    methods: ['GET', 'POST'],
  });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    req.log.error({ err }, 'request failed');
    const status = err.statusCode ?? 500;
    if (status === 413) {
      return reply.code(303).redirect(`${config.siteUrl}/submitted/?status=error&msg=${encodeURIComponent('That image is over 5 MB. Please upload a smaller one.')}`);
    }
    if (req.headers.accept?.includes('text/html') && !req.url.startsWith('/api')) {
      return reply.code(status).type('text/html').send(`<p style="font-family:system-ui;padding:2rem">Something went wrong (${status}). <a href="${config.siteUrl}">Back to the site</a></p>`);
    }
    return reply.code(status).send({ error: status >= 500 ? 'Internal error' : err.message });
  });

  await app.register(webhookRoutes);
  await app.register(publicRoutes);
  await app.register(adminRoutes);

  app.get('/', async (_req, reply) => reply.redirect(config.siteUrl));
  return app;
}

async function main() {
  await migrate();
  await startQueue();
  const app = await buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const shutdown = async (sig: string) => {
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    await stopQueue();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
