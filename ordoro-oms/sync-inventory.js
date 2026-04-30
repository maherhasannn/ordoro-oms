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
        for (const qty of Object.values(warehouses)) {
          total += Number(qty ?? 0);
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
        // token expired mid-sync, get a new one
        console.log("[turn14] Token expired, refreshing...");
        const newToken = await getToken();
        headers.Authorization = `Bearer ${newToken}`;
        page--; // retry this page
        continue;
      }
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

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log("=== Inventory Sync ===\n");

  // run all syncs
  await syncEkeystone();
  console.log("");
  await syncMeyer();
  console.log("");
  await syncTurn14();

  console.log("\n=== Done ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
