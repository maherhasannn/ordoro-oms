-- Run this in the Supabase SQL editor to create all tables.

-- 1. orders — top-level order from Ordoro
create table if not exists orders (
  id               text primary key,            -- Ordoro order number
  status           text,
  order_date       timestamptz,
  customer_name    text,
  shipping_address jsonb,
  raw_payload      jsonb,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- 2. order_lines — one row per line item
create table if not exists order_lines (
  id               bigint generated always as identity primary key,
  order_id         text references orders(id) on delete cascade,
  line_number      int,
  sku              text,
  mpn              text,
  product_name     text,
  quantity         int,
  unit_price       numeric(10,2),

  -- fulfillment decision (filled in by OMS)
  chosen_supplier  text,          -- 'turn14' | 'ekeystone' | 'meyer' | null
  supplier_cost    numeric(10,2),
  supplier_stock   int,
  decision_reason  text,
  decided_at       timestamptz,

  -- drop-ship flag (set from "Contains DS Items" tag)
  is_ds            boolean default false,

  -- stable identity from Ordoro (preferred over line_number index)
  ordoro_line_id   text,

  -- retry tracking for failed lines
  retry_count      int default 0,

  -- kit expansion: links component rows back to the original kit SKU
  kit_parent_sku   text,

  -- state machine ('manual' = warehouse part, skip supplier matching)
  status           text not null default 'pending'
    check (status in ('pending', 'decided', 'ordering', 'ordered', 'shipped', 'failed', 'manual', 'expanded')),
  external_order_id text,
  idempotency_key  text,

  -- order placement
  supplier_product_id text,       -- Turn14 product_id / eKeystone VCPN / Meyer SKU
  supplier_order_id   bigint,     -- FK to supplier_orders (added after table exists)
  supplier_po_number  text,
  ordered_at          timestamptz,

  -- tracking
  tracking_number     text,
  tracking_carrier    text,
  shipped_at          timestamptz,
  tracking_synced_to_ordoro boolean default false,

  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists idx_order_lines_order on order_lines(order_id);
create index if not exists idx_order_lines_pending
  on order_lines(id) where status = 'pending';
create unique index if not exists idx_order_lines_idempotency
  on order_lines(idempotency_key) where idempotency_key is not null;

-- 3. product_map — MPN → supplier-specific IDs
create table if not exists product_map (
  mpn                text primary key,
  turn14_product_id  text,
  ekeystone_vcpn     text,
  meyer_sku          text,
  created_at         timestamptz default now()
);

-- 4. turn14_inventory — cached from paginated API
create table if not exists turn14_inventory (
  product_id   text primary key,             -- Turn14 product ID
  part_number  text,
  mfr_part_number text,
  product_name text,
  brand        text,
  stock        int default 0,
  cost         numeric(10,2),
  map_price    numeric(10,2),
  updated_at   timestamptz default now()
);

create index if not exists idx_turn14_mfr_part on turn14_inventory(mfr_part_number);

-- 5. ekeystone_inventory — cached FTP feed (inventory daily, pricing weekly)
create table if not exists ekeystone_inventory (
  vcpn             text primary key,             -- Vendor Line Code + Part Number
  mfr_part_number  text,
  stock            int default 0,
  cost             numeric(10,2),
  list_price       numeric(10,2),
  updated_at       timestamptz default now()
);

create index if not exists idx_ekeystone_mfr_part on ekeystone_inventory(mfr_part_number);

-- 6. meyer_inventory — cached from SFTP push feed
create table if not exists meyer_inventory (
  meyer_sku        text primary key,
  mfr_part_number  text,
  product_name     text,
  stock            int default 0,
  cost             numeric(10,2),
  list_price       numeric(10,2),
  updated_at       timestamptz default now()
);

create index if not exists idx_meyer_mfr_part on meyer_inventory(mfr_part_number);

-- 7. supplier_orders — one row per PO sent to a supplier
create table if not exists supplier_orders (
  id                bigint generated always as identity primary key,
  order_id          text references orders(id),
  supplier          text not null,           -- 'turn14' | 'ekeystone' | 'meyer'
  po_number         text not null unique,
  external_order_id text,
  quote_id          text,                    -- Turn14 only
  status            text not null default 'pending'
    check (status in ('pending', 'placed', 'partially_shipped', 'shipped', 'failed', 'cancelled')),
  shipping_address  jsonb,
  items             jsonb,
  total_cost        numeric(10,2),
  error_message     text,
  placed_at         timestamptz,
  shipped_at        timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists idx_supplier_orders_order on supplier_orders(order_id);
create index if not exists idx_supplier_orders_active
  on supplier_orders(status) where status in ('placed', 'partially_shipped');

-- FK from order_lines to supplier_orders
alter table order_lines add constraint fk_order_lines_supplier_order
  foreign key (supplier_order_id) references supplier_orders(id);
create index if not exists idx_order_lines_supplier_order on order_lines(supplier_order_id);

-- 8. sync_state — persisted polling watermark
create table if not exists sync_state (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);

-- ── Migration for existing databases ─────────────────────
-- Run these ALTER statements if the tables already exist:
--
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS ordoro_line_id text;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS retry_count int DEFAULT 0;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS kit_parent_sku text;
-- ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_status_check;
-- ALTER TABLE order_lines ADD CONSTRAINT order_lines_status_check CHECK (status IN ('pending', 'decided', 'ordering', 'ordered', 'shipped', 'failed', 'manual', 'expanded'));
--
-- ── Order placement migration ───────────────────────────
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS supplier_product_id text;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS supplier_order_id bigint;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS supplier_po_number text;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS ordered_at timestamptz;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS tracking_number text;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS tracking_carrier text;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS shipped_at timestamptz;
-- ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS tracking_synced_to_ordoro boolean DEFAULT false;
-- CREATE TABLE IF NOT EXISTS supplier_orders ( ... ); -- see full definition above
-- ALTER TABLE order_lines ADD CONSTRAINT fk_order_lines_supplier_order FOREIGN KEY (supplier_order_id) REFERENCES supplier_orders(id);
