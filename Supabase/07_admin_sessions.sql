create table if not exists admin_sessions (
  token text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
