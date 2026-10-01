import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable is validated here, once, at boot. A bad or missing value fails loudly with the variable
 * name instead of surfacing later as a dead link in a customer email or a silently disabled bot check.
 */
const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
const PLACEHOLDER = /change-me|REPLACE_ME|xxxx|example\.com|you@/i;
const notPlaceholder = (name: string) => (v: string) => !PLACEHOLDER.test(v) || `${name} still holds the placeholder from .env.example`;
const url = z.string().url();
const trimSlash = (s: string) => s.replace(/\/$/, '');

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).refine(notPlaceholder('DATABASE_URL')),
  // PEM certificate chain for the Postgres server (Supabase: Project Settings > Database > SSL certificate). Required in production so
  // the connection verifies the server instead of accepting any certificate.
  DATABASE_CA: z.string().optional(),
  SITE_URL: url.transform(trimSlash).default('http://localhost:4321'),
  // Where this API is reachable by browsers and in emails (private edit links, renewals, admin). Required in production.
  API_BASE_URL: url.transform(trimSlash).optional(),
  SITE_NAME: z.string().default('Lantle'),
  OWNER_EMAIL: z.string().email().refine(notPlaceholder('OWNER_EMAIL')),
  ADMIN_PASSWORD: z.string().min(16, 'ADMIN_PASSWORD must be at least 16 characters').refine(notPlaceholder('ADMIN_PASSWORD')),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').refine(notPlaceholder('SESSION_SECRET')),
  ALLOWED_ORIGINS: z.string().default(''),
  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_BUCKET: z.string().default('tools'),
  DODO_MODE: z.enum(['test', 'live']).default('test'),
  DODO_API_KEY: z.string().default(''),
  DODO_WEBHOOK_SECRET: z.string().default(''),
  DODO_PRODUCT_FEATURED: z.string().default(''),
  DODO_PRODUCT_SPONSORED: z.string().default(''),
  DODO_PRODUCT_WRITING_ADDON: z.string().default(''),
  DODO_PRODUCT_DIRECTORY_PACKAGE: z.string().default(''),
  DODO_PRODUCT_INSTANT: z.string().default(''),
  DODO_BUNDLE_DISCOUNT_CODE: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('onboarding@resend.dev'),
  EMAIL_DOMAIN_VERIFIED: z.enum(['true', 'false']).default('false'),
  TURNSTILE_SECRET: z.string().default(''),
  CF_DEPLOY_HOOK_URL: z.string().default(''),
  BUNDLE_DISCOUNT_PERCENT: z.coerce.number().min(0).max(100).default(15),
  PENDING_ORDER_DAYS: z.coerce.number().int().positive().default(14),
}).superRefine((e, ctx) => {
  if (!isProd) return;
  // Production-only requirements. Each one has caused a silent failure mode when missing.
  if (!e.API_BASE_URL) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['API_BASE_URL'], message: 'Required in production: private edit links in emails point here' });
  if (!e.TURNSTILE_SECRET) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TURNSTILE_SECRET'], message: 'Required in production: without it the public forms have no bot check' });
  if (!e.DATABASE_CA && !/localhost|127\.0\.0\.1/.test(e.DATABASE_URL)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_CA'], message: 'Required in production: the Postgres certificate must be verified' });
  if (!/^https:/.test(e.SITE_URL)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SITE_URL'], message: 'Must be https in production' });
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
  throw new Error(`Invalid environment. See .env.example.\n${lines.join('\n')}`);
}
const e = parsed.data;

export const config = {
  port: e.PORT,
  env: e.NODE_ENV,
  isProd,
  databaseUrl: e.DATABASE_URL,
  databaseCa: e.DATABASE_CA,
  siteUrl: e.SITE_URL,
  // Falls back to the site URL in development only; in production the schema above makes API_BASE_URL mandatory.
  apiBaseUrl: e.API_BASE_URL ?? e.SITE_URL,
  siteName: e.SITE_NAME,
  allowedOrigins: e.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  supabase: {
    url: trimSlash(e.SUPABASE_URL),
    key: e.SUPABASE_SERVICE_ROLE_KEY,
    bucket: e.SUPABASE_BUCKET,
  },
  dodo: {
    apiKey: e.DODO_API_KEY,
    webhookSecret: e.DODO_WEBHOOK_SECRET,
    mode: e.DODO_MODE,
    products: {
      featured: e.DODO_PRODUCT_FEATURED,
      sponsored: e.DODO_PRODUCT_SPONSORED,
      writingAddon: e.DODO_PRODUCT_WRITING_ADDON,
      directoryPackage: e.DODO_PRODUCT_DIRECTORY_PACKAGE,
      instant: e.DODO_PRODUCT_INSTANT,
    },
    // A percentage-off discount code created in the Dodo dashboard (e.g. BUNDLE15). Applied automatically when an order qualifies for the bundle discount.
    bundleDiscountCode: e.DODO_BUNDLE_DISCOUNT_CODE,
  },
  email: {
    resendKey: e.RESEND_API_KEY,
    from: e.EMAIL_FROM,
    domainVerified: e.EMAIL_DOMAIN_VERIFIED === 'true',
    owner: e.OWNER_EMAIL,
  },
  turnstileSecret: e.TURNSTILE_SECRET,
  admin: {
    password: e.ADMIN_PASSWORD,
    sessionSecret: e.SESSION_SECRET,
  },
  deployHookUrl: e.CF_DEPLOY_HOOK_URL,
  // Shown in emails and the admin. Actual charge amounts are set on the products in Dodo and must match these.
  prices: {
    featured: { cents: 9900, label: '$99 per year' },
    sponsored: { cents: 12900, label: '$129 per article' },
    writingAddon: { cents: 1900, label: '$19' },
    directoryPackage: { cents: 19900, label: '$199 one time' },
    // Skip the review queue: published on payment, read by an editor afterwards, refunded if declined.
    instant: { cents: 2900, label: '$29 one time' },
  },
  featuredTermDays: 365,
  // Order builder: percent off when an order contains at least `minItems` different fixed-price items. Mirror of BUNDLE_DISCOUNT in the site config.
  bundle: { percent: e.BUNDLE_DISCOUNT_PERCENT, minItems: 2 },
  // Unpaid orders older than this are marked expired by the daily job, so abandoned checkouts do not pile up.
  pendingOrderDays: e.PENDING_ORDER_DAYS,
};
