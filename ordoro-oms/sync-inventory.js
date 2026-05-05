/**
 * Bulk inventory sync — pulls Turn14 + eKeystone + Meyer into Supabase.
 * Usage: node sync-inventory.js
 *
 * Turn14: paginates /v1/items + /v1/inventory (747 pages, ~8 min)
 * eKeystone: downloads FTP feed (already handled by syncFeed)
 * Meyer: downloads SFTP push feed from our server
 */
import "dotenv/config";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import * as ekeystone from "./suppliers/ekeystone.js";
import * as meyer from "./suppliers/meyer.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const T14_BASE = process.env.TURN14_BASE_URL || "https://api.turn14.com/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Turn14 Token ────────────────────────────────────────

async function getToken() {
  const res = await axios.post(`${T14_BASE}/token`, {
    grant_type: "client_credentials",
    client_id: process.env.TURN14_CLIENT_ID,
    client_secret: process.env.TURN14_CLIENT_SECRET,
  });
  return res.data.access_token;
}

// ── Turn14 Sync ─────────────────────────────────────────

async function syncTurn14() {
  console.log("[turn14] Starting bulk sync...");
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };

  // get total pages
  const probe = await axios.get(`${T14_BASE}/items?page=1&limit=100`, { headers });
  const totalPages = probe.data.meta?.total_pages || 1;
  console.log(`[turn14] ${totalPages} pages to fetch`);

  let totalSynced = 0;

  let authRetries = 0;
  const MAX_AUTH_RETRIES = 3;

  for (let page = 1; page <= totalPages; page++) {
    try {
      // fetch items + inventory for this page in parallel
      const [itemsRes, invRes] = await Promise.all([
        axios.get(`${T14_BASE}/items?page=${page}&limit=100`, { headers }),
        axios.get(`${T14_BASE}/inventory?page=${page}&limit=100`, { headers }),
      ]);

      const items = itemsRes.data.data || [];
      const invData = invRes.data.data || [];

      // build inventory lookup by product id
      const invMap = {};
      for (const inv of invData) {
        const warehouses = inv.attributes?.inventory || {};
        let total = 0;
        for (const wh of Object.values(warehouses)) {
          // handle both shapes: { stock: N } (object) or N (plain number)
          const val = typeof wh === "object" && wh !== null ? wh.stock : wh;
          total += Number(val ?? 0);
        }
        invMap[inv.id] = total;
      }

      // build rows to upsert
      const rows = items.map((item) => ({
        product_id: item.id,
        part_number: item.attributes?.part_number || null,
        mfr_part_number: item.attributes?.mfr_part_number || null,
        product_name: item.attributes?.product_name || null,
        brand: item.attributes?.brand || null,
        stock: invMap[item.id] ?? 0,
        cost: null, // pricing requires per-item API call, fetched on-demand
        map_price: null,
        updated_at: new Date().toISOString(),
      }));

      // upsert to Supabase
      if (rows.length > 0) {
        const { error } = await supabase
          .from("turn14_inventory")
          .upsert(rows, { onConflict: "product_id" });
        if (error) {
          console.error(`[turn14] Page ${page} upsert error:`, error.message);
        } else {
          totalSynced += rows.length;
        }
      }

      if (page % 50 === 0 || page === totalPages) {
        console.log(`[turn14] Page ${page}/${totalPages} — ${totalSynced} items synced so far`);
      }

      // rate limit: 5 GET/sec, we do 2 per iteration → wait 500ms
      await sleep(500);
    } catch (err) {
      if (err.response?.status === 401) {
        authRetries++;
        if (authRetries > MAX_AUTH_RETRIES) {
          throw new Error(`[turn14] Persistent 401 after ${MAX_AUTH_RETRIES} token refreshes — aborting sync`);
        }
        console.log(`[turn14] Token expired, refreshing (attempt ${authRetries}/${MAX_AUTH_RETRIES})...`);
        const newToken = await getToken();
        headers.Authorization = `Bearer ${newToken}`;
        page--; // retry this page
        continue;
      }
      authRetries = 0; // reset on non-401 errors (token is working)
      console.error(`[turn14] Page ${page} error:`, err.message);
      await sleep(2000); // back off on errors
    }
  }

  console.log(`[turn14] Bulk sync complete — ${totalSynced} items total`);
}

// ── eKeystone Sync ──────────────────────────────────────

async function syncEkeystone() {
  if (!process.env.EKEYSTONE_FTP_HOST) {
    console.log("[ekeystone] FTP not configured, skipping");
    return;
  }
  console.log("[ekeystone] Starting FTP feed sync...");
  await ekeystone.syncFeed();
}

// ── Meyer Sync ──────────────────────────────────────────

async function syncMeyer() {
  if (!process.env.MEYER_SFTP_HOST) {
    console.log("[meyer] SFTP not configured, skipping");
    return;
  }
  console.log("[meyer] Starting SFTP feed sync...");
  await meyer.syncFeed();
}

// ── Build Product Map ────────────────────────────────────
// Cross-references all three supplier inventory tables by mfr_part_number
// to build a unified mapping of MPN → supplier-specific IDs.

async function fetchAllRows(table, columns) {
  const allRows = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .not("mfr_part_number", "is", null)
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    allRows.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return allRows;
}

async function buildProductMap() {
  console.log("[product_map] Building from synced inventory...");

  const [t14Rows, ekeyRows, meyRows] = await Promise.all([
    fetchAllRows("turn14_inventory", "product_id, mfr_part_number, stock"),
    fetchAllRows("ekeystone_inventory", "vcpn, mfr_part_number, stock"),
    fetchAllRows("meyer_inventory", "meyer_sku, mfr_part_number, stock"),
  ]);

  console.log(
    `[product_map] Source rows — Turn14: ${t14Rows.length}, eKeystone: ${ekeyRows.length}, Meyer: ${meyRows.length}`
  );

  const map = new Map();

  for (const r of t14Rows) {
    const entry = map.get(r.mfr_part_number) || { mpn: r.mfr_part_number };
    // if duplicate MPN within Turn14, keep the row with highest stock
    if (!entry.turn14_product_id || r.stock > (entry._t14s || 0)) {
      entry.turn14_product_id = r.product_id;
      entry._t14s = r.stock;
    }
    map.set(r.mfr_part_number, entry);
  }

  for (const r of ekeyRows) {
    const entry = map.get(r.mfr_part_number) || { mpn: r.mfr_part_number };
    if (!entry.ekeystone_vcpn || r.stock > (entry._eks || 0)) {
      entry.ekeystone_vcpn = r.vcpn;
      entry._eks = r.stock;
    }
    map.set(r.mfr_part_number, entry);
  }

  for (const r of meyRows) {
    const entry = map.get(r.mfr_part_number) || { mpn: r.mfr_part_number };
    if (!entry.meyer_sku || r.stock > (entry._ms || 0)) {
      entry.meyer_sku = r.meyer_sku;
      entry._ms = r.stock;
    }
    map.set(r.mfr_part_number, entry);
  }

  // strip internal tracking fields, prepare for upsert
  const rows = [...map.values()].map((e) => ({
    mpn: e.mpn,
    turn14_product_id: e.turn14_product_id || null,
    ekeystone_vcpn: e.ekeystone_vcpn || null,
    meyer_sku: e.meyer_sku || null,
  }));

  console.log(`[product_map] ${rows.length} unique MPNs across all suppliers`);

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("product_map")
      .upsert(chunk, { onConflict: "mpn" });
    if (error) throw error;
  }

  console.log(`[product_map] Upserted ${rows.length} mappings`);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log("=== Inventory Sync ===\n");

  // run all syncs — continue on individual failures so the rest still complete
  try { await syncEkeystone(); } catch (err) { console.error("[ekeystone] Sync failed:", err.message); }
  console.log("");
  try { await syncMeyer(); } catch (err) { console.error("[meyer] Sync failed:", err.message); }
  console.log("");
  try { await syncTurn14(); } catch (err) { console.error("[turn14] Sync failed:", err.message); }
  console.log("");
  try { await buildProductMap(); } catch (err) { console.error("[product_map] Build failed:", err.message); }

  console.log("\n=== Done ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
