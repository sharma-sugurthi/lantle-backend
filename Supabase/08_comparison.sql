-- Structured comparison data on tools. All optional; the compare and alternatives pages get richer as it fills in.
alter table tools add column if not exists pros text[] not null default '{}';
alter table tools add column if not exists cons text[] not null default '{}';
alter table tools add column if not exists key_features text[] not null default '{}';
alter table tools add column if not exists platforms text[] not null default '{}';
alter table tools add column if not exists integrations text[] not null default '{}';
alter table tools add column if not exists starting_price text;
alter table tools add column if not exists free_tier boolean;
alter table tools add column if not exists trial_days int;
alter table tools add column if not exists deployment text check (deployment in ('cloud', 'self-hosted', 'both'));
alter table tools add column if not exists company_size text[] not null default '{}';
alter table tools add column if not exists verdict_line text;
alter table tools add column if not exists data_checked_at date;

-- Editorial verdicts for the pairs with real search demand. Everything else renders the templated comparison.
create table if not exists comparisons (
  id uuid primary key default gen_random_uuid(),
  tool_a text not null,
  tool_b text not null,
  verdict_md text not null default '',
  pick_a_if text[] not null default '{}',
  pick_b_if text[] not null default '{}',
  winner text,
  winner_reason text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  reviewed_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comparisons_pair_order check (tool_a < tool_b),
  constraint comparisons_pair_unique unique (tool_a, tool_b)
);
