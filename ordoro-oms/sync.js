import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

import {
  upsertOrder,
  getUnprocessedLines,
  updateOrderLineDecision,
  getSyncState,
  setSyncState,
  getStuckOrderingLines,
  markLineFailed,
  getRetryableFailedLines,
  resetLineForRetry,
  lookupProductMap,
} from "./db.js";
import { withTimeout } from "./lib/timeout.js";
import * as turn14 from "./suppliers/turn14.js";
import * as ekeystone from "./suppliers/ekeystone.js";
import * as meyer from "./suppliers/meyer.js";
import { selectBestDeal } from "./lib/bestDeal.js";
import { alertUnfulfillable } from "./lib/notify.js";

// ── Helpers ─────────────────────────────────────────────

function toPST(iso) {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
}

// ── Config ──────────────────────────────────────────────

const POLL_INTERVAL = 180_000; // 3 minutes
const MAX_CACHE_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours — reject eKeystone cache older than this
const EKEYSTONE_SYNC_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours (feed updates daily)
const MEYER_SYNC_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours (Meyer pushes periodically)
const WATERMARK_KEY = "ordoro_last_sync";
const ORDORO_API_TIMEOUT = 15_000;
const WATERMARK_OVERLAP_MS = 30_000;

const auth = Buffer.from(
  `${process.env.ORDORO_CLIENT}:${process.env.ORDORO_SECRET}`
).toString("base64");

// ── Kit Components ───────────────────────────────────────

async function fetchKitComponents(sku) {
  const res = await withTimeout(
    axios.get(
      `https://api.ordoro.com/product/${encodeURIComponent(sku)}/`,
      { headers: { Authorization: `Basic ${auth}` } }
    ),
    ORDORO_API_TIMEOUT,
    `ordoro product ${sku}`
  );
  const components = res.data.kit_components || [];
  return components.map((c) => ({ componentSku: c.sku, quantity: c.quantity, isKitParent: c.is_kit_parent === true }));
}

// ── Ordoro Polling ──────────────────────────────────────

async function fetchOrders(since) {
  const allOrders = [];
  let offset = 0;
  const limit = 50;

  // Fix: paginate to avoid silently dropping orders when >50 are updated
  while (true) {
    const res = await withTimeout(
      axios.get(
        `https://api.ordoro.com/v3/order?updated_after=${encodeURIComponent(since)}&limit=${limit}&offset=${offset}`,
        { headers: { Authorization: `Basic ${auth}` } }
      ),
      ORDORO_API_TIMEOUT,
      "ordoro fetchOrders"
    );
    const orders = res.data.order || [];
    allOrders.push(...orders);

    if (orders.length < limit) break; // last page
    offset += limit;
  }

  return allOrders;
}

// ── Supplier Check (isolated try/catch per supplier) ────

async function checkSupplierByMpn(name, fn, mpn, mappedId) {
  try {
    return await fn(mpn, mappedId);
  } catch (err) {
    console.error(`  [${name}] error for MPN ${mpn}: ${err.message}`);
    return null;
  }
}

// ── Live Verification ───────────────────────────────────

const LIVE_CHECK_FN = {
  turn14: turn14.liveCheck,
  meyer: meyer.liveCheck,
  ekeystone: ekeystone.liveCheck,
};

// ── Process a single unprocessed line ───────────────────

async function processLine(line) {
  const tag = `Order #${line.order_id} line ${line.sku || line.mpn} (qty ${line.quantity})`;

  if (line.status !== "pending") {
    console.log(`  ${tag} — skipping (status: ${line.status})`);
    return;
  }

  // 1. Look up product_map for supplier-specific IDs (handles MPN mismatches)
  const mapping = await lookupProductMap(line.mpn);

  // 2. Check all 3 suppliers in parallel — prefer mapped ID, fall back to MPN
  const [t14, ekey, mey] = await Promise.all([
    checkSupplierByMpn("turn14", turn14.checkByMpn, line.mpn, mapping?.turn14_product_id),
    checkSupplierByMpn("ekeystone", ekeystone.checkByMpn, line.mpn, mapping?.ekeystone_vcpn),
    checkSupplierByMpn("meyer", meyer.checkByMpn, line.mpn, mapping?.meyer_sku),
  ]);

  const results = [t14, ekey, mey].filter(Boolean);

  if (results.length === 0) {
    // Fix: transient errors — leave as pending so it retries next cycle
    // instead of permanently marking as failed
    console.log(`  ${tag} — all supplier checks failed (will retry next cycle)`);
    return;
  }

  // 3. Pick best deal (cheapest supplier with a known cost — stock is informational)
  const decision = selectBestDeal(results, line.quantity);

  // 4. Live verification — try to confirm cost/stock via live API
  // Include any supplier with a supplierId (not filtered by stock).
  // Sorted by cost so cheapest is tried first.
  const candidates = results
    .filter((r) => r.supplierId)
    .sort((a, b) => (a.cost || Infinity) - (b.cost || Infinity));

  if (candidates.length > 0) {
    let verified = false;
    for (const candidate of candidates) {
      const liveCheckFn = LIVE_CHECK_FN[candidate.supplier];
      const liveResult = await liveCheckFn(candidate.supplierId);

      if (liveResult.status === "no_api") {
        // No live API (e.g., eKeystone) — need a cached cost and fresh cache
        if (!candidate.cost || candidate.cost <= 0) {
          console.log(`  ${tag} -> ${candidate.supplier} has no live API and no cached cost, skipping`);
          continue;
        }
        const cacheAge = candidate.cachedAt
          ? Date.now() - new Date(candidate.cachedAt).getTime()
          : Infinity;

        if (cacheAge > MAX_CACHE_AGE_MS) {
          const ageHrs = Math.round(cacheAge / 3_600_000);
          console.log(`  ${tag} -> ${candidate.supplier} cache too stale (${ageHrs}h old), skipping`);
          continue;
        }

        console.log(`  ${tag} -> verified ${candidate.supplier} (no live API, cached: stock ${candidate.stock}, cost $${candidate.cost})`);
        decision.chosen_supplier = candidate.supplier;
        decision.supplier_cost = candidate.cost;
        decision.supplier_stock = candidate.stock;
        decision.decision_reason = `cheapest (cached, no live API)`;
        verified = true;
        break;
      }

      if (liveResult.status === "error") {
        console.error(`  [${candidate.supplier}] live check failed: ${liveResult.error}, skipping`);
        continue;
      }

      // status === "ok" — use live data
      const liveCost = liveResult.cost || candidate.cost;
      if (!liveCost || liveCost <= 0) {
        console.log(`  ${tag} -> ${candidate.supplier} live verified but no cost available, skipping`);
        continue;
      }
      console.log(`  ${tag} -> live verified ${candidate.supplier} (stock: ${liveResult.stock}, cost: $${liveCost})`);
      decision.chosen_supplier = candidate.supplier;
      decision.supplier_cost = liveCost;
      decision.supplier_stock = liveResult.stock;
      decision.decision_reason = `cheapest (live verified)`;
      verified = true;
      break;
    }

    if (!verified) {
      const detail = candidates
        .map((r) => `${r.supplier}: cached ${r.stock} in stock`)
        .join("; ");
      decision.chosen_supplier = null;
      decision.supplier_cost = null;
      decision.supplier_stock = null;
      decision.decision_reason = `all suppliers failed live verification: ${detail}`;
    }
  }

  // 5. Log the final decision
  if (decision.chosen_supplier) {
    console.log(
      `  ${tag} -> ${decision.chosen_supplier} ` +
        `at $${decision.supplier_cost}/unit (stock: ${decision.supplier_stock}) ` +
        `[${decision.decision_reason}]`
    );
  } else {
    console.log(`  ${tag} -> ${decision.decision_reason}`);
    // alert only when the item truly doesn't exist at any supplier
    await alertUnfulfillable(line, decision);
  }

  // 6. Persist decision
  decision.order_id = line.order_id;
  decision.line_number = line.line_number;
  await updateOrderLineDecision(line.id, decision);
}

// ── Main Poll Cycle ─────────────────────────────────────

let pollRunning = false;

async function pollCycle() {
  // Fix: guard against concurrent cycles when a cycle exceeds POLL_INTERVAL
  if (pollRunning) {
    console.log("[poll] Previous cycle still running — skipping");
    return;
  }
  pollRunning = true;

  try {
    // load watermark
    let lastSync =
      (await getSyncState(WATERMARK_KEY)) ||
      new Date(Date.now() - 5 * 60 * 1000).toISOString();

    console.log(`\n[poll] Polling since: ${toPST(lastSync)}`);

    // fetch orders from Ordoro
    const orders = await fetchOrders(lastSync);

    if (orders.length === 0) {
      console.log("[poll] No new orders");
    } else {
      console.log(`[poll] Fetched ${orders.length} order(s)`);

      // upsert to Supabase (idempotent — re-fetched orders are harmless)
      for (const o of orders) {
        const kitExpansions = await upsertOrder(o, fetchKitComponents);
        const tags = (Array.isArray(o.tags) ? o.tags : []).map(t => t.text || t);
        const isDs = tags.includes("Contains DS Items");
        const tagStr = tags.length > 0 ? tags.join(", ") : "(none)";
        const updatedAt = o.updated_at || o.created_date;
        console.log(`[poll]  ${isDs ? "★ DS" : "    "} ${o.order_number} [tags: ${tagStr}] updated=${toPST(updatedAt)}`);
        for (const exp of kitExpansions) {
          console.log(`[poll]    ★ KIT ${o.order_number} line ${exp.lineIndex} (${exp.kitSku}) -> expanded to ${exp.dsCount} DS + ${exp.warehouseCount} warehouse components`);
        }
      }
    }

    // Advance watermark to (now - overlap window).
    // Always advances with wall-clock time, regardless of order timestamps.
    // The overlap ensures we never miss orders; re-fetches are harmless
    // because upserts are idempotent.
    const watermark = new Date(Date.now() - WATERMARK_OVERLAP_MS).toISOString();
    await setSyncState(WATERMARK_KEY, watermark);
    console.log(`[poll] Watermark: ${toPST(lastSync)} -> ${toPST(watermark)}`);

    // process unprocessed lines (from this batch and any previous)
    const lines = await getUnprocessedLines();
    if (lines.length > 0) {
      console.log(`[decide] Processing ${lines.length} unprocessed line(s)...`);
      for (const line of lines) {
        await processLine(line);
      }
    }

    // Fix: periodically retry failed lines (stock may have been restocked)
    try {
      const retryable = await getRetryableFailedLines();
      if (retryable.length > 0) {
        console.log(`[retry] Resetting ${retryable.length} failed line(s) for re-evaluation`);
        for (const line of retryable) {
          await resetLineForRetry(line.id, line.retry_count);
        }
      }
    } catch (retryErr) {
      console.error("[retry] Error checking retryable lines:", retryErr.message);
    }
  } catch (err) {
    console.error("[poll] Top-level error:", err.message);
  } finally {
    pollRunning = false;
  }
}

// ── eKeystone Feed Sync ─────────────────────────────────

async function syncEkeystone() {
  try {
    await ekeystone.syncFeed();
  } catch (err) {
    console.error("[ekeystone] Feed sync failed:", err.message);
  }
}

// ── Meyer SFTP Feed Sync ────────────────────────────────

async function syncMeyer() {
  try {
    await meyer.syncFeed();
  } catch (err) {
    console.error("[meyer] Feed sync failed:", err.message);
  }
}

// ── Startup ─────────────────────────────────────────────

async function main() {
  console.log("=== OMS Simulation Mode ===");
  console.log("Orders will be evaluated but NOT placed with suppliers.\n");

  // startup recovery — reset lines stuck in 'ordering' from a prior crash
  try {
    const stuck = await getStuckOrderingLines(10);
    if (stuck.length > 0) {
      console.log(`[recovery] Found ${stuck.length} lines stuck in 'ordering' — resetting to pending`);
      for (const line of stuck) {
        await markLineFailed(line.id, "reset after process restart", true);
      }
    }
  } catch (err) {
    console.error("[recovery] Error checking stuck lines:", err.message);
  }

  // // TEMP: skipping feed syncs for testing — polling only
  // if (process.env.EKEYSTONE_FTP_HOST) {
  //   await syncEkeystone();
  //   setInterval(syncEkeystone, EKEYSTONE_SYNC_INTERVAL);
  // } else {
  //   console.log("[ekeystone] FTP not configured — skipping feed sync");
  // }
  // if (process.env.MEYER_SFTP_HOST) {
  //   await syncMeyer();
  //   setInterval(syncMeyer, MEYER_SYNC_INTERVAL);
  // } else {
  //   console.log("[meyer] SFTP not configured — skipping feed sync");
  // }
  console.log("[startup] Feed syncs disabled for testing — polling only");

  // first poll immediately, then every 3 minutes
  await pollCycle();
  setInterval(pollCycle, POLL_INTERVAL);
}

main();
