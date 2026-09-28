# Lantle backend

Submissions, payments, emails and the admin queue for the directory. The site itself stays static on Cloudflare Pages and reads published tools from this API at build time.

Stack: Node 22, Fastify, Postgres (Supabase), pg-boss job queue, Supabase Storage for thumbnails, Dodo Payments, Resend.

## What it does

- `POST /submissions` takes the submit form (multipart, with an optional screenshot), stores the tool as `pending`, emails you, and for paid plans sends the buyer straight to a Dodo checkout page.
- `POST /forms/contact`, `/forms/service-order`, `/forms/guest-pitch`, `/forms/newsletter` replace Formspree. Each redirects back to the site's `/thanks/` page.
- `GET /checkout/directory-package` starts a checkout for the $199 package.
- `POST /webhooks/dodo` verifies the signature, stores the event once, and a queued job marks the order paid, grants featured placement, and sends the emails.
- `GET /api/tools` and `GET /api/posts` are what the site builds from. `GET /api/tools/counts` feeds the sitemap.
- Sponsored articles follow the same path as tools: submitted into the database, edited and approved in the admin, published by a rebuild. Editorial articles are written in the admin too (Articles > New article). No markdown anywhere.
- Every submitter gets a private edit link (`/s/<token>`) in their emails. While a submission is in review they can update it; "Request changes" in the admin sends them a note with that link; on a live page the link only lets them send a note.
- `/admin` is the queue. Approve publishes the tool and triggers a Cloudflare rebuild; the submitter gets a "you are live" email a few minutes later.
- Daily job: 30 day featured expiry reminders with a renewal link. Weekly job: rebuild so expired featured placements drop back to basic.

## Setup checklist

1. **Supabase**: new project (free). Copy the **Session pooler** connection string from Project Settings > Database (port 5432). Do not use the transaction pooler on 6543. Create a Storage bucket named `tools`, set it to public. Copy the project URL and the service role key from Project Settings > API.
2. **Heroku**: create the app, Basic dyno. Connect the GitHub repo or push with the Heroku CLI. Set every variable from `.env.example` as a config var (`heroku config:set KEY=value`). `DATABASE_URL`, `OWNER_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET` and `SITE_URL` are required to boot; everything else can come later.
3. **Import the reviews** (once, from your machine, with `DATABASE_URL` and the Supabase vars in `.env`):
   ```
   npm install
   npm run import
   ```
   All 109 reviews, their comparison data (`seed/comparison/*.json`), the 13 editorial verdicts (`seed/comparisons.json`), the 5 blog posts and their images ship in `seed/`. The script uploads the thumbnails to Storage and upserts every tool by slug as published, so it is safe to run again on a database that already has the first 63. Add missing thumbnails later from the admin, one upload each.
4. **Site**: in Cloudflare Pages > Settings > Environment variables, set `TOOLS_API_URL=https://<your-app>.herokuapp.com`. Create a deploy hook (Settings > Builds) and paste its URL into `CF_DEPLOY_HOOK_URL` on Heroku. Redeploy the site.
5. **Dodo Payments**: once approved, create four products (Featured listing $99, Sponsored article $89, Writing add-on $19, Directory package $199), paste the product ids and the API key, add a webhook pointing at `https://<your-app>.herokuapp.com/webhooks/dodo` subscribed to payment and refund events, paste the webhook secret, set `DODO_MODE=live`. Until then paid options still work: the submission is saved, the buyer sees "we will email a payment link", and you get notified.
6. **Resend**: create the account and an API key. Until your domain is verified, keep `EMAIL_DOMAIN_VERIFIED=false`: only emails to `OWNER_EMAIL` are sent, everything else is logged. When the domain is live, add its DNS records in Resend, set `EMAIL_FROM=hello@yourdomain` and `EMAIL_DOMAIN_VERIFIED=true`.
7. **Turnstile** (recommended): Cloudflare dashboard > Turnstile > add site. Put the secret in `TURNSTILE_SECRET` here and the site key in `site.config.ts` on the site.
8. Open `https://<your-app>.herokuapp.com/admin`, log in with `ADMIN_PASSWORD`.

## Local development

```
cp .env.example .env      # point DATABASE_URL at a local Postgres or your Supabase project
npm install
npm run dev               # http://localhost:3000, admin at /admin
```

The site's `npm run dev` needs `TOOLS_API_URL=http://localhost:3000` in its own `.env`.

## Operations

- `GET /health` returns `{ ok, payments, storage, emailDomainVerified }`. Point a free uptime monitor at it when you want one.
- Failed background jobs email you and appear under Admin > Jobs with a retry button.
- Migrations in `migrations/*.sql` run automatically on boot.
- Taxonomy lives in `src/taxonomy.ts` here and `src/data/taxonomy.ts` in the site. Change both when adding a vertical or a feature label.

## Pay first, complete later, and the order builder

Paid items no longer ask for the full description before checkout. A featured listing or a sponsored article is created with the minimum (name, website, email, category), the buyer goes straight to Dodo, and the confirmation email plus the thank-you page carry the private link (`/s/<token>`) where they complete the listing or add the draft. Such rows carry `listing_complete = false`, show an "incomplete" pill in the admin queue, and cannot be approved until the submitter has saved the missing parts. Free listings still require the full description up front.

The services page has an order builder for the fixed-price items (featured listing, sponsored articles with the writing add-on, directory package). It posts to `/checkout/order-builder`, which creates one `bundle` order with the items in `metadata`, one placeholder tool or post row per item (each with its own private link), and one Dodo checkout with all products in the cart. Quoted work (guest posts, SEO content, LinkedIn) still goes through the order form and gets a payment link by email.

Bundle discount: `BUNDLE_DISCOUNT_PERCENT` (default 15) applies when an order has at least two different fixed-price items. Create a percentage discount code for that amount in the Dodo dashboard and put its code in `DODO_BUNDLE_DISCOUNT_CODE`; it is passed to the checkout session automatically. If the code is not set, a qualifying order is saved and you are emailed to send a manual payment link, so nobody is overcharged. Keep the percent equal to `BUNDLE_DISCOUNT` in the site config.

`GET /checkout/order/:id/summary` returns the order status and the private links (the thank-you page polls it, so it shows "paid" only once the webhook has confirmed it). `GET /checkout/order/:id` re-opens the checkout for an unpaid order. Unpaid orders older than `PENDING_ORDER_DAYS` (default 14) are marked expired by the daily job.

## Comparison data and verdicts

Every tool carries structured comparison fields (pros, cons, features from a per-vertical vocabulary, platforms, integrations, starting price, free plan, trial, deployment, company size, a one-line verdict). They drive the site's `/tools/compare/a-vs-b/` and `/tools/alternatives/x/` pages and the facts box on each tool page. Submitters fill them in on the submit form and their private edit link; you edit them in the "Comparison data" block on the admin tool page. "Save and mark as checked today" stamps `data_checked_at`, which the site shows as the verification date, so only press it after opening the vendor's pricing page.

The feature matrix shows a tick for a listed feature, a cross only when the tool has feature data and the label is missing, and "not listed" when no data has been captured. Unknown is never shown as a no.

Admin > Comparisons holds hand-written verdicts for pairs with search demand (Power BI vs Tableau, Ramp vs Brex, ...). A pair without a row still gets a full data-driven page. Both tools must be in the same vertical. Featured (paid) placement is never an input to a ranking, a label or a verdict.

Note on the seed data: the research agents could only reach a few vendor sites, so `verified` is true (and `data_checked_at` set) for 3 of 109 tools. The rest is filled from knowledge and shows without a check date until you confirm it in the admin. Start with the tools behind the high-volume pages: Notion, Shopify, Semrush, DocuSign, Intercom, Calendly, Zendesk, Cursor and Tableau alternatives.
