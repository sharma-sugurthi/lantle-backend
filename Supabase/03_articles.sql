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
