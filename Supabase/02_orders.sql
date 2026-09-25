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
