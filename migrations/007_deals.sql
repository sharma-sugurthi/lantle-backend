-- Deals rail: a listed tool can attach one live discount. Shown on its tool page, the category page, the home page and the API.
-- Any listed tool may add one (free or featured); it is never a ranking input.
alter table tools add column if not exists deal_text text;
alter table tools add column if not exists deal_code text;
alter table tools add column if not exists deal_url text;
alter table tools add column if not exists deal_until date;
create index if not exists tools_deal_live_idx on tools (deal_until) where deal_text is not null;
