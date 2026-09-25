create table if not exists webhook_events (
  id text primary key,
  provider text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
