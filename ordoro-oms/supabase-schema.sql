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

  -- state machine
  status           text not null default 'pending'
    check (status in ('pending', 'decided', 'ordering', 'ordered', 'failed')),
  external_order_id text,
  idempotency_key  text,

  created_at       timestamptz default now()
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

-- 7. sync_state — persisted polling watermark
create table if not exists sync_state (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);
