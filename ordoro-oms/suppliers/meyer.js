import axios from "axios";
import SftpClient from "ssh2-sftp-client";
import { parse } from "csv-parse";
import { Readable } from "stream";
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

  try {
    // ── Phase 1: download + parse inventory, then free it ──
    console.log("[meyer] Downloading inventory_feed.csv...");
    let invContent = (await sftp.get(`${dir}/inventory_feed.csv`)).toString("utf-8");
    console.log(`[meyer] Inventory feed: ${(invContent.length / 1024 / 1024).toFixed(1)} MB`);

    const invMap = new Map();
    const invParser = Readable.from(invContent).pipe(parse(CSV_OPTS));
    invContent = null;
    for await (const r of invParser) {
      const sku = r["Item Number"];
      if (!sku) continue;
      invMap.set(sku, {
        stock: Math.floor(Number(r["Available"]) || 0),
        stocking: r["Stocking"] === "Yes",
        mfr_part_number: r["MFG Item Number"] || null,
      });
    }
    console.log(`[meyer] Parsed ${invMap.size} inventory SKUs`);

    // ── Phase 2: download + parse pricing, merge, upsert ───
    console.log("[meyer] Downloading pricing_feed.csv...");
    let priceContent = (await sftp.get(`${dir}/pricing_feed.csv`)).toString("utf-8");
    console.log(`[meyer] Pricing feed: ${(priceContent.length / 1024 / 1024).toFixed(1)} MB`);

    await sftp.end();

    const BATCH = 500;
    let batch = [];
    let totalMerged = 0;
    const priceParser = Readable.from(priceContent).pipe(parse(CSV_OPTS));
    priceContent = null;
    for await (const p of priceParser) {
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

    console.log(`[meyer] Feed sync complete — ${totalMerged} items cached (${invMap.size} had inventory data)`);
  } catch (err) {
    console.error(`[meyer] SFTP feed sync failed: ${err.message}`);
    try { await sftp.end(); } catch (_) {}
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
  const createOrderUrl = process.env.MEYER_CREATE_ORDER_URL;
  const vendorId = process.env.MEYER_VENDOR_ID;
  const customerNumber = process.env.MEYER_CUSTOMER_NUMBER;
  if (!createOrderUrl || !vendorId) {
    throw new Error("Meyer order placement not configured (MEYER_CREATE_ORDER_URL / MEYER_VENDOR_ID)");
  }

  await rateLimit("meyer");

  const payload = {
    VendorID: Number(vendorId),
    CustomerNumber: customerNumber,
    PONumber: poNumber,
    Items: items.map((i) => ({
      VendorSKU: i.supplierId,
      Quantity: i.quantity,
    })),
    ShipToName: shippingAddress.ShipToName,
    ShipToAddress1: shippingAddress.ShipToAddress1,
    ShipToAddress2: shippingAddress.ShipToAddress2 || "",
    ShipToCity: shippingAddress.ShipToCity,
    ShipToState: shippingAddress.ShipToState,
    ShipToZip: shippingAddress.ShipToZip,
    ShipToCountry: shippingAddress.ShipToCountry || "US",
  };

  const res = await withTimeout(
    axios.post(createOrderUrl, payload, { headers: authHeaders() }),
    MEYER_ORDER_TIMEOUT,
    "meyer CreateOrder"
  );

  const data = res.data;
  const externalOrderId =
    data?.OrderSourceOrderID || data?.OrderNumber || data?.order_id;

  if (!externalOrderId) {
    const errMsg = data?.ErrorMessage || data?.Message || JSON.stringify(data);
    throw new Error(`Meyer order failed: ${errMsg}`);
  }

  return { externalOrderId: String(externalOrderId) };
}

// ── Tracking ───────────────────────────────────────────

export async function getTracking(externalOrderId) {
  const trackingUrl = process.env.MEYER_TRACKING_URL;
  if (!trackingUrl) return null;

  try {
    await rateLimit("meyer");
    const res = await withTimeout(
      axios.get(trackingUrl, {
        headers: authHeaders(),
        params: {
          OrderSourceOrderID: externalOrderId,
          CustomerNumber: process.env.MEYER_CUSTOMER_NUMBER,
        },
      }),
      MEYER_API_TIMEOUT,
      `meyer tracking ${externalOrderId}`
    );

    const data = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!data || !data.TrackingNumber) return null;

    return {
      trackingNumber: data.TrackingNumber || null,
      carrier: data.ShipMethod || data.Carrier || null,
      status: data.Status || null,
    };
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}
