import axios from "axios";
import SftpClient from "ssh2-sftp-client";
import { parse } from "csv-parse";
import { createReadStream } from "fs";
import { unlink, stat } from "fs/promises";
import { upsertMeyerInventory, getMeyerInventory, getMeyerByMpn } from "../db.js";
import { withTimeout } from "../lib/timeout.js";
import { rateLimit } from "../lib/rateLimit.js";

const BASE =
  process.env.MEYER_API_URL ||
  "https://meyerapi.meyerdistributing.com/http/default/ProdAPI/v2";
const MEYER_FEED_TIMEOUT = 600_000; // 10 minutes (48+ MB file)
const MEYER_API_TIMEOUT = 10_000;

function authHeaders() {
  return { Authorization: `Espresso ${process.env.MEYER_API_KEY}:1` };
}

// ── SFTP Feed Sync ──────────────────────────────────────
// Meyer pushes two CSV files to our SFTP server:
//   inventory_feed.csv — columns: MFGName, MFG Item Number, Item Number, Available, ...
//   pricing_feed.csv   — columns: MFG, MFG Item Number, Meyer Part, Description, Jobber Price, Your Price, ...
// We merge them on Item Number / Meyer Part and cache to Supabase.

export async function syncFeed() {
  const host = process.env.MEYER_SFTP_HOST;
  const port = Number(process.env.MEYER_SFTP_PORT) || 22;
  const user = process.env.MEYER_SFTP_USER;
  const pass = process.env.MEYER_SFTP_PASS;
  const dir = process.env.MEYER_SFTP_DIR || "/inbound/inventory";

  if (!host || !user) {
    console.log("[meyer] SFTP not configured — skipping feed sync");
    return;
  }

  const CSV_OPTS = {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  };

  const sftp = new SftpClient();

  try {
    console.log(`[meyer] Connecting to SFTP ${host}:${port}...`);
    await sftp.connect({ host, port, username: user, password: pass });
  } catch (err) {
    console.error(`[meyer] SFTP connect failed: ${err.message}`);
    throw err;
  }

  const INV_TMP = "/tmp/meyer_inventory.csv";
  const PRICE_TMP = "/tmp/meyer_pricing.csv";

  try {
    // ── Phase 1: download inventory to disk, parse from disk ──
    console.log("[meyer] Downloading inventory_feed.csv...");
    await sftp.fastGet(`${dir}/inventory_feed.csv`, INV_TMP);
    const invSize = (await stat(INV_TMP)).size;
    console.log(`[meyer] Inventory feed: ${(invSize / 1024 / 1024).toFixed(1)} MB`);

    const invMap = new Map();
    for await (const r of createReadStream(INV_TMP, "utf-8").pipe(parse(CSV_OPTS))) {
      const sku = r["Item Number"];
      if (!sku) continue;
      invMap.set(sku, {
        stock: Math.floor(Number(r["Available"]) || 0),
        stocking: r["Stocking"] === "Yes",
        mfr_part_number: r["MFG Item Number"] || null,
      });
    }
    await unlink(INV_TMP);
    console.log(`[meyer] Parsed ${invMap.size} inventory SKUs`);

    // ── Phase 2: download pricing to disk, merge, upsert ───
    console.log("[meyer] Downloading pricing_feed.csv...");
    await sftp.fastGet(`${dir}/pricing_feed.csv`, PRICE_TMP);
    const priceSize = (await stat(PRICE_TMP)).size;
    console.log(`[meyer] Pricing feed: ${(priceSize / 1024 / 1024).toFixed(1)} MB`);

    await sftp.end();

    const BATCH = 500;
    let batch = [];
    let totalMerged = 0;
    for await (const p of createReadStream(PRICE_TMP, "utf-8").pipe(parse(CSV_OPTS))) {
      const sku = p["Meyer Part"];
      if (!sku) continue;

      const inv = invMap.get(sku);
      batch.push({
        meyer_sku: sku,
        mfr_part_number: inv?.mfr_part_number || p["MFG Item Number"] || null,
        product_name: p["Description"] || null,
        stock: inv ? inv.stock : 0,
        cost: Number(p["Your Price"]) || 0,
        list_price: Number(p["Jobber Price"]) || 0,
      });

      if (batch.length >= BATCH) {
        await upsertMeyerInventory(batch);
        totalMerged += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await upsertMeyerInventory(batch);
      totalMerged += batch.length;
    }
    await unlink(PRICE_TMP);

    console.log(`[meyer] Feed sync complete — ${totalMerged} items cached (${invMap.size} had inventory data)`);
  } catch (err) {
    console.error(`[meyer] SFTP feed sync failed: ${err.message}`);
    try { await sftp.end(); } catch (_) {}
    try { await unlink(INV_TMP); } catch (_) {}
    try { await unlink(PRICE_TMP); } catch (_) {}
    throw err;
  }
}

// ── REST API: Item Information (live check) ─────────────

export async function getItemInfo(itemNumber, customerNumber) {
  await rateLimit("meyer");
  const custNum = customerNumber || process.env.MEYER_CUSTOMER_NUMBER;
  const res = await withTimeout(
    axios.get(`${BASE}/ItemInformation`, {
      headers: authHeaders(),
      params: { CustomerNumber: custNum, ItemNumber: itemNumber },
    }),
    MEYER_API_TIMEOUT,
    `meyer GET ItemInformation ${itemNumber}`
  );
  const items = Array.isArray(res.data) ? res.data : [];
  return items[0] || null;
}

// ── Check single SKU (uses cached SFTP data, falls back to REST API) ──

export async function check(sku) {
  // try cached SFTP data first (faster, no API call)
  const cached = await getMeyerInventory(sku);
  if (cached) {
    return {
      supplier: "meyer",
      stock: cached.stock,
      cost: Number(cached.cost) || 0,
    };
  }

  // fall back to REST API directly (not via liveCheck which returns structured status)
  const item = await getItemInfo(sku);
  if (!item) return { supplier: "meyer", stock: 0, cost: 0 };
  return {
    supplier: "meyer",
    stock: Number(item.QtyAvailable ?? 0),
    cost: Number(item.CustomerPrice ?? 0),
  };
}

export async function checkByMpn(mpn, mappedSku = null) {
  // 1. Try cached data first
  let row = null;
  if (mappedSku) row = await getMeyerInventory(mappedSku);
  if (!row) row = await getMeyerByMpn(mpn);
  if (row) {
    return {
      supplier: "meyer",
      stock: row.stock,
      cost: Number(row.cost) || 0,
      supplierId: row.meyer_sku,
      cachedAt: row.updated_at || null,
    };
  }

  // 2. No cache — fall back to live API if we have a mapped Meyer SKU
  if (mappedSku) {
    try {
      const item = await getItemInfo(mappedSku);
      if (item) {
        return {
          supplier: "meyer",
          stock: Number(item.QtyAvailable ?? 0),
          cost: Number(item.CustomerPrice ?? 0),
          supplierId: mappedSku,
          cachedAt: null,
        };
      }
    } catch (err) {
      console.error(`  [meyer] live fallback failed for SKU ${mappedSku}: ${err.message}`);
    }
  }

  return { supplier: "meyer", stock: 0, cost: 0, supplierId: null, cachedAt: null };
}

// ── Live check (always hits REST API, bypasses cache) ──

export async function liveCheck(sku) {
  try {
    const item = await getItemInfo(sku);
    if (!item) return { status: "ok", stock: 0, cost: 0 };
    return {
      status: "ok",
      stock: Number(item.QtyAvailable ?? 0),
      cost: Number(item.CustomerPrice ?? 0),
    };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

// ── Order Placement ────────────────────────────────────

const MEYER_ORDER_TIMEOUT = 30_000;

export async function placeOrder({ poNumber, items, shippingAddress }) {
  const customerNumber = process.env.MEYER_CUSTOMER_NUMBER;
  const shipMethod = process.env.MEYER_DEFAULT_SHIP_METHOD || "FEDEX GRND";
  if (!customerNumber) {
    throw new Error("Meyer order placement not configured (MEYER_CUSTOMER_NUMBER)");
  }

  await rateLimit("meyer");

  // CustPO: max 20 chars, must be unique per Meyer API
  const custPO = poNumber.replace(/-meyer/, "").slice(0, 20);

  const payload = {
    ShipMethod: shipMethod,
    CustPO: custPO,
    CollectedSalesTax: "Yes",
    ShipToName: shippingAddress.ShipToName || "",
    ShipToAddress1: shippingAddress.ShipToAddress1 || "",
    ShipToAddress2: shippingAddress.ShipToAddress2 || "",
    ShipToCity: shippingAddress.ShipToCity || "",
    ShipToState: shippingAddress.ShipToState || "",
    ShipToZipcode: shippingAddress.ShipToZipcode || "",
    ShipToCountry: shippingAddress.ShipToCountry || "USA",
    ShipToPhone: shippingAddress.ShipToPhone || "",
    Items: items.map((i) => ({
      ItemNumber: i.supplierId,
      Quantity: i.quantity,
    })),
  };

  const res = await withTimeout(
    axios.post(`${BASE}/CreateOrder`, payload, {
      headers: authHeaders(),
      params: { CustomerNumber: customerNumber, Consolidate: 1 },
    }),
    MEYER_ORDER_TIMEOUT,
    "meyer CreateOrder"
  );

  const data = res.data;
  const orders = data?.Orders;
  if (!orders || orders.length === 0) {
    const errMsg = data?.errorMessage || data?.Message || JSON.stringify(data);
    throw new Error(`Meyer order failed: ${errMsg}`);
  }

  // Meyer may split into multiple orders across warehouses
  const orderNumbers = orders.map((o) => o.OrderNumber);
  return { externalOrderId: orderNumbers.join(",") };
}

// ── Tracking ───────────────────────────────────────────

export async function getTracking(externalOrderId) {
  const customerNumber = process.env.MEYER_CUSTOMER_NUMBER;
  if (!customerNumber) return null;

  try {
    // externalOrderId may be comma-separated if Meyer split the order
    const orderNumbers = externalOrderId.split(",");

    for (const orderNum of orderNumbers) {
      await rateLimit("meyer");
      const res = await withTimeout(
        axios.get(`${BASE}/SalesTracking`, {
          headers: authHeaders(),
          params: {
            OrderNumber: orderNum.trim(),
            CustomerNumber: customerNumber,
          },
        }),
        MEYER_API_TIMEOUT,
        `meyer tracking ${orderNum}`
      );

      const entries = Array.isArray(res.data) ? res.data : [];
      for (const entry of entries) {
        if (entry.TrackingNumber) {
          return {
            trackingNumber: entry.TrackingNumber,
            carrier: entry.ShipMethod || null,
            status: entry.DeliveryETA || null,
          };
        }
      }
    }

    return null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}
