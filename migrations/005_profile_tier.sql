-- Basic vs Full profile tier for free tool listings.
-- basic = submitted 7 core fields (shown as a card with tagline + screenshot only)
-- full  = submitted all description fields; unlocks sidebar, pros/cons bullets, compare pages
alter table tools add column if not exists profile_tier text not null default 'full'
  check (profile_tier in ('basic', 'full'));

-- Existing rows are all 'full' (they were submitted with the old complete form).
-- New basic-only submissions will have profile_tier = 'basic' and listing_complete = false
-- until they upgrade via the private link.
