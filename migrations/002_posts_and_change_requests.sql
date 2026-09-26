-- Articles (editorial, sponsored, guest) live here. The site builds the blog from /api/posts.
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  description text not null default '',
  body_md text not null default '',
  author text not null default 'Lantle Editorial',
  author_bio text,
  tags text[] not null default '{}',
  thumbnail_url text,
  kind text not null default 'editorial' check (kind in ('editorial', 'sponsored', 'guest')),
  status text not null default 'pending' check (status in ('pending', 'changes_requested', 'published', 'rejected', 'archived')),
  order_id uuid references orders (id) on delete set null,
  company text,
  website text,
  submitter_email text,
  submitter_name text,
  written_by_us boolean not null default false,
  notes text,
  review_note text,
  reject_reason text,
  edit_token text unique,
  pub_date timestamptz not null default now(),
  updated_date timestamptz,
  published_at timestamptz,
  live_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists posts_status_idx on posts (status);

-- Tools can be sent back to the submitter with a note, and submitters get a private edit link.
alter table tools add column if not exists edit_token text unique;
alter table tools add column if not exists review_note text;
alter table tools drop constraint if exists tools_status_check;
alter table tools add constraint tools_status_check check (status in ('pending', 'changes_requested', 'published', 'rejected', 'archived'));

-- Move anything already in the old articles table, then retire it.
insert into posts (slug, title, body_md, kind, status, order_id, company, website, submitter_email, submitter_name, written_by_us, created_at)
select 'sponsored-' || substr(id::text, 1, 8), title, draft, 'sponsored',
       case status when 'published' then 'published' when 'rejected' then 'rejected' else 'pending' end,
       order_id, company, website, email, author_name, written_by_us, created_at
from articles
on conflict (slug) do nothing;
drop table if exists articles;
