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
