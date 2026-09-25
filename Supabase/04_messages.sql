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
