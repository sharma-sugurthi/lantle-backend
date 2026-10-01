import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { MAX_UPLOAD_BYTES } from './lib/storage.js';
import { startQueue, stopQueue } from './queue.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';
import apiRoutes from './routes/api.js';
import webhookRoutes from './routes/webhooks.js';

export async function buildApp() {
  // Request logging is done by the onResponse hook below with the URL redacted: raw URLs carry private edit tokens and order ids.
  const app = Fastify({ logger: { level: config.isProd ? 'info' : 'debug' }, disableRequestLogging: true, // Trust exactly one proxy hop (the Heroku router, which appends the real client IP to X-Forwarded-For). `true` would take the
    // left-most, client-supplied value and let anyone bypass every rate limit, including the admin login limiter.
    trustProxy: (_addr: string, hop: number) => hop === 0, bodyLimit: 256 * 1024 });

  await app.register(cookie, { secret: config.admin.sessionSecret });
  await app.register(formbody);
  await app.register(multipart, { attachFieldsToBody: 'keyValues', limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 40, fieldSize: 64 * 1024 } });
  await app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : true,
    methods: ['GET', 'POST'],
  });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(helmet, {
    // The admin and private-link pages render server-side HTML with small inline handlers, so scripts are self + inline;
    // every remote script, frame and form target is still blocked. Images may come from Supabase Storage.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        formAction: ["'self'", config.siteUrl],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'same-origin' },
  });
  if (config.isProd) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.headers['x-forwarded-proto'] === 'http') return reply.code(301).redirect(`${config.apiBaseUrl}${req.url}`);
    });
  }
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/s/') || req.url.startsWith('/admin') || req.url.startsWith('/checkout/order/')) reply.header('cache-control', 'no-store');
  });
  // One line per request with secrets removed: /s/<token> and order ids are credentials, query strings carry emails.
  const redact = (url: string) => url.split('?')[0].replace(/^\/s\/[a-f0-9]+/, '/s/[token]').replace(/\/checkout\/order\/[0-9a-f-]{36}/, '/checkout/order/[id]').replace(/\/featured-renewal\/[0-9a-f-]{36}/, '/featured-renewal/[id]');
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ method: req.method, url: redact(req.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
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
  await app.register(apiRoutes);
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
