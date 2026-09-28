import 'dotenv/config';

const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}. See .env.example.`);
  return v;
};
const opt = (k: string, d = ''): string => process.env[k] ?? d;

export const config = {
  port: Number(opt('PORT', '3000')),
  env: opt('NODE_ENV', 'development'),
  isProd: opt('NODE_ENV', 'development') === 'production',
  databaseUrl: req('DATABASE_URL'),
  siteUrl: opt('SITE_URL', 'http://localhost:4321').replace(/\/$/, ''),
  siteName: opt('SITE_NAME', 'Lantle'),
  allowedOrigins: opt('ALLOWED_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean),
  supabase: {
    url: opt('SUPABASE_URL').replace(/\/$/, ''),
    key: opt('SUPABASE_SERVICE_ROLE_KEY'),
    bucket: opt('SUPABASE_BUCKET', 'tools'),
  },
  dodo: {
    apiKey: opt('DODO_API_KEY'),
    webhookSecret: opt('DODO_WEBHOOK_SECRET'),
    mode: opt('DODO_MODE', 'test') as 'test' | 'live',
    products: {
      featured: opt('DODO_PRODUCT_FEATURED'),
      sponsored: opt('DODO_PRODUCT_SPONSORED'),
      writingAddon: opt('DODO_PRODUCT_WRITING_ADDON'),
      directoryPackage: opt('DODO_PRODUCT_DIRECTORY_PACKAGE'),
    },
    // A percentage-off discount code created in the Dodo dashboard (e.g. BUNDLE15). Applied automatically when an order qualifies for the bundle discount.
    bundleDiscountCode: opt('DODO_BUNDLE_DISCOUNT_CODE'),
  },
  email: {
    resendKey: opt('RESEND_API_KEY'),
    from: opt('EMAIL_FROM', 'onboarding@resend.dev'),
    domainVerified: opt('EMAIL_DOMAIN_VERIFIED', 'false') === 'true',
    owner: req('OWNER_EMAIL'),
  },
  turnstileSecret: opt('TURNSTILE_SECRET'),
  admin: {
    password: req('ADMIN_PASSWORD'),
    sessionSecret: req('SESSION_SECRET'),
  },
  deployHookUrl: opt('CF_DEPLOY_HOOK_URL'),
  // Shown in emails and the admin. Actual charge amounts are set on the products in Dodo.
  prices: {
    featured: { cents: 9900, label: '$99 per year' },
    sponsored: { cents: 8900, label: '$89 per article' },
    writingAddon: { cents: 1900, label: '$19' },
    directoryPackage: { cents: 19900, label: '$199 one time' },
  },
  featuredTermDays: 365,
  // Order builder: percent off when an order contains at least `minItems` different fixed-price items. Mirror of BUNDLE_DISCOUNT in the site config.
  bundle: { percent: Number(opt('BUNDLE_DISCOUNT_PERCENT', '15')), minItems: 2 },
  // Unpaid orders older than this are marked expired by the daily job, so abandoned checkouts do not pile up.
  pendingOrderDays: Number(opt('PENDING_ORDER_DAYS', '14')),
};
