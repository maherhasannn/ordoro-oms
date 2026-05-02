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
} from "./db.js";
import { withTimeout } from "./lib/timeout.js";
import * as turn14 from "./suppliers/turn14.js";
import * as ekeystone from "./suppliers/ekeystone.js";
import * as meyer from "./suppliers/meyer.js";
import { selectBestDeal } from "./lib/bestDeal.js";
import { alertUnfulfillable } from "./lib/notify.js";

// ── Config ──────────────────────────────────────────────

const POLL_INTERVAL = 180_000; // 15 seconds
const EKEYSTONE_SYNC_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours (feed updates daily)
const MEYER_SYNC_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours (Meyer pushes periodically)
const WATERMARK_KEY = "ordoro_last_sync";
const ORDORO_API_TIMEOUT = 15_000;
const WATERMARK_OVERLAP_MS = 30_000;

const auth = Buffer.from(
  `${process.env.ORDORO_CLIENT}:${process.env.ORDORO_SECRET}`
).toString("base64");

// ── Ordoro Polling ──────────────────────────────────────

async function fetchOrders(since) {
  const res = await withTimeout(
    axios.get(
      `https://api.ordoro.com/v3/order?updated_after=${encodeURIComponent(since)}&limit=50`,
      { headers: { Authorization: `Basic ${auth}` } }
    ),
    ORDORO_API_TIMEOUT,
    "ordoro fetchOrders"
  );
  return res.data.order || [];
}

// ── Supplier Check (isolated try/catch per supplier) ────

async function checkSupplierByMpn(name, fn, mpn) {
  try {
    return await fn(mpn);
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

  const MIN_STOCK_BUFFER = 4;
  const minStock = Math.max(line.quantity, MIN_STOCK_BUFFER);

  // 1. Check all 3 suppliers by MPN in parallel
  const [t14, ekey, mey] = await Promise.all([
    checkSupplierByMpn("turn14", turn14.checkByMpn, line.mpn),
    checkSupplierByMpn("ekeystone", ekeystone.checkByMpn, line.mpn),
    checkSupplierByMpn("meyer", meyer.checkByMpn, line.mpn),
  ]);

  const results = [t14, ekey, mey].filter(Boolean);

  if (results.length === 0) {
    console.log(`  ${tag} — all supplier checks failed`);
    await updateOrderLineDecision(line.id, {
      decision_reason: "all supplier checks failed",
    });
    return;
  }

  // 3. Pick best deal (initial selection based on cached/first-pass data)
  const decision = selectBestDeal(results, line.quantity);

  // 4. Live verification — confirm stock in real-time before committing
  if (decision.chosen_supplier) {
    // sort eligible suppliers by cost (cheapest first) for fallback
    const candidates = results
      .filter((r) => r.stock >= minStock && r.cost > 0)
      .sort((a, b) => a.cost - b.cost);

    let verified = false;
    for (const candidate of candidates) {
      const liveCheckFn = LIVE_CHECK_FN[candidate.supplier];
      const liveResult = await liveCheckFn(candidate.supplierId);

      if (liveResult.status === "no_api") {
        // eKeystone: no live API, trust cached data
        console.log(`  ${tag} -> verified ${candidate.supplier} (no live API, using cached: ${candidate.stock} in stock)`);
        decision.chosen_supplier = candidate.supplier;
        decision.supplier_cost = candidate.cost;
        decision.supplier_stock = candidate.stock;
        decision.decision_reason = `cheapest with ${minStock}+ stock (cached, no live API)`;
        verified = true;
        break;
      }

      if (liveResult.status === "error") {
        // API failed — do NOT trust cache, skip supplier
        console.error(`  [${candidate.supplier}] live check failed: ${liveResult.error}, skipping`);
        continue;
      }

      // status === "ok" — verify stock
      if (liveResult.stock >= minStock) {
        console.log(`  ${tag} -> live verified ${candidate.supplier} (live stock: ${liveResult.stock}, cost: $${liveResult.cost})`);
        decision.chosen_supplier = candidate.supplier;
        decision.supplier_cost = liveResult.cost || candidate.cost;
        decision.supplier_stock = liveResult.stock;
        decision.decision_reason = `cheapest with ${minStock}+ stock (live verified)`;
        verified = true;
        break;
      } else {
        console.log(`  ${tag} -> ${candidate.supplier} failed live check (stock: ${liveResult.stock}, need ${minStock}+)`);
      }
    }

    // all candidates failed live verification
    if (!verified) {
      const detail = candidates
        .map((r) => `${r.supplier}: cached ${r.stock} in stock`)
        .join("; ");
      decision.chosen_supplier = null;
      decision.supplier_cost = null;
      decision.supplier_stock = null;
      decision.decision_reason = `all suppliers failed live verification (need ${minStock}+): ${detail}`;
    }
  }

  // 5. Log the final decision
  if (decision.chosen_supplier) {
    console.log(
      `  ${tag} -> would be fulfilled by ${decision.chosen_supplier} ` +
        `at $${decision.supplier_cost}/unit (stock: ${decision.supplier_stock}) ` +
        `[${decision.decision_reason}]`
    );
  } else {
    console.log(`  ${tag} -> ${decision.decision_reason}`);
    // send email alert for unfulfillable lines
    await alertUnfulfillable(line, decision);
  }

  // 6. Persist decision
  decision.order_id = line.order_id;
  decision.line_number = line.line_number;
  await updateOrderLineDecision(line.id, decision);
}

// ── Main Poll Cycle ─────────────────────────────────────

async function pollCycle() {
  try {
    // load watermark
    let lastSync =
      (await getSyncState(WATERMARK_KEY)) ||
      new Date(Date.now() - 5 * 60 * 1000).toISOString();

    console.log(`\n[poll] Polling since: ${lastSync}`);

    // fetch orders from Ordoro
    const orders = await fetchOrders(lastSync);

    if (orders.length === 0) {
      console.log("[poll] No new orders");
    } else {
      console.log(`[poll] Found ${orders.length} orders`);

      // upsert to Supabase
      for (const o of orders) {
        await upsertOrder(o);
        const tags = (o.tags || []).map(t => t.text || t);
        const isDs = tags.includes("Contains DS Items");
        const tagStr = tags.length > 0 ? tags.join(", ") : "(none)";
        console.log(`  Saved order ${o.order_number} [tags: ${tagStr}]${isDs ? " ★ DS" : " — skipping (no DS tag)"}`);
      }

      // advance watermark
      const newest = orders.reduce(
        (max, o) =>
          new Date(o.updated_at || o.created_date) > new Date(max)
            ? o.updated_at || o.created_date
            : max,
        lastSync
      );
      const watermark = new Date(new Date(newest).getTime() - WATERMARK_OVERLAP_MS).toISOString();
      await setSyncState(WATERMARK_KEY, watermark);
      console.log(`[poll] Watermark advanced to ${watermark} (30s overlap)`);
    }

    // process unprocessed lines (from this batch and any previous)
    const lines = await getUnprocessedLines();
    if (lines.length > 0) {
      console.log(`[decide] Processing ${lines.length} unprocessed line(s)...`);
      for (const line of lines) {
        await processLine(line);
      }
    }
  } catch (err) {
    console.error("[poll] Top-level error:", err.message);
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

  // first poll immediately, then every 15s
  await pollCycle();
  setInterval(pollCycle, POLL_INTERVAL);
}

main();
