create extension if not exists pgcrypto;

create table if not exists tools (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  website text not null,
  tagline text not null,
  vertical text not null,
  category text not null,
  pricing text not null check (pricing in ('Free', 'Freemium', 'Paid', 'Enterprise')),
  best_for text not null default '',
  rating numeric(2,1) check (rating between 1 and 5),
  editors_pick boolean not null default false,
  thumbnail_url text,
  body_md text not null default '',
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected', 'archived')),
  plan text not null default 'basic' check (plan in ('basic', 'featured')),
  paid_until timestamptz,
  submitter_email text,
  submitter_name text,
  notes text,
  reject_reason text,
  added_at timestamptz not null default now(),
  published_at timestamptz,
  live_notified_at timestamptz,
  reminder_sent_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists tools_status_idx on tools (status);
create index if not exists tools_vertical_idx on tools (vertical);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('featured', 'sponsored', 'directory_package')),
  tool_id uuid references tools (id) on delete set null,
  email text,
  name text,
  amount_cents int not null,
  currency text not null default 'USD',
  provider text not null default 'dodo',
  provider_session_id text,
  provider_payment_id text unique,
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists orders_status_idx on orders (status);

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders (id) on delete set null,
  company text not null,
  website text,
  email text not null,
  author_name text,
  title text not null,
  draft text not null,
  written_by_us boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'paid', 'published', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('contact', 'service_order', 'guest_pitch')),
  name text,
  email text not null,
  company text,
  interest text,
  message text not null,
  ip_hash text,
  created_at timestamptz not null default now()
);

create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now(),
  unsubscribed_at timestamptz
);

create table if not exists webhook_events (
  id text primary key,
  provider text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create table if not exists admin_sessions (
  token text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
