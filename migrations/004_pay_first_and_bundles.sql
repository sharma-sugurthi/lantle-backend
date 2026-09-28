-- Pay first, complete later: paid listings and articles are created with the minimum and finished from the private link.
alter table tools add column if not exists listing_complete boolean not null default true;
alter table posts add column if not exists listing_complete boolean not null default true;

-- Orders can now be a bundle of several fixed-price items (from the order builder), carry a discount, and expire when never paid.
alter table orders drop constraint if exists orders_kind_check;
alter table orders add constraint orders_kind_check check (kind in ('featured', 'sponsored', 'directory_package', 'bundle'));
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('pending', 'paid', 'refunded', 'failed', 'expired'));
alter table orders add column if not exists discount_cents int not null default 0;
create index if not exists orders_status_created_idx on orders (status, created_at);
