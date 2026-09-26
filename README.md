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
3. **Import the 63 reviews** (once, from your machine, with `DATABASE_URL` and the Supabase vars in `.env`):
   ```
   npm install
   npm run import
   ```
   All 63 reviews, the 5 blog posts and their images ship in `seed/`. The script uploads the thumbnails to Storage and inserts every tool as published. Safe to run again. (`npm run import -- ../seo-tool` imports from a site checkout instead, if you ever keep markdown there again.) Add the 44 missing thumbnails later from the admin, one upload each.
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
- Taxonomy lives in `src/taxonomy.ts` here and `src/data/taxonomy.ts` in the site. Change both when adding a vertical.
