-- Instant publish: a paid, skip-the-queue listing that goes live on payment and is read by an editor afterwards.
alter table orders drop constraint if exists orders_kind_check;
alter table orders add constraint orders_kind_check check (kind in ('featured', 'sponsored', 'directory_package', 'bundle', 'instant'));

-- Indexes for the joins the admin and the order pages run on every request.
create index if not exists orders_tool_id_idx on orders (tool_id);
create index if not exists posts_order_id_idx on posts (order_id);
create index if not exists orders_metadata_gin on orders using gin (metadata);
create index if not exists webhook_events_unprocessed_idx on webhook_events (received_at) where processed_at is null;
