import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
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
  isManualShipSku,
  isInstructionSku,
  markLineManualShip,
  claimLineForOrdering,
  markLineOrdered,
  getDecidedLinesGrouped,
  getOrderShippingAddress,
  createSupplierOrder,
  linkLinesToSupplierOrder,
  markSupplierOrderPlaced,
  markSupplierOrderFailed,
  existingSupplierOrder,
  getOrdersAwaitingTracking,
  getLinesForSupplierOrder,
  updateLineTracking,
  markSupplierOrderShipped,
  markSupplierOrderPartiallyShipped,
  getUnSyncedShippedLines,
  markTrackingSyncedToOrdoro,
} from "./db.js";
import { withTimeout } from "./lib/timeout.js";
import * as turn14 from "./suppliers/turn14.js";
import * as ekeystone from "./suppliers/ekeystone.js";
import * as meyer from "./suppliers/meyer.js";
import { selectBestDeal } from "./lib/bestDeal.js";
import { alertUnfulfillable, alertOrderPlacementFailed } from "./lib/notify.js";
import {
  mapAddressForTurn14,
  mapAddressForEkeystone,
  mapAddressForMeyer,
} from "./lib/addressMapper.js";

// ── Helpers ─────────────────────────────────────────────

function toPST(iso) {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
}

// ── Config ──────────────────────────────────────────────

const POLL_INTERVAL = 180_000; // 3 minutes
const MAX_CACHE_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours — reject eKeystone cache older than this
const EKEYSTONE_SYNC_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours (feed updates daily)
const MEYER_SYNC_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours (Meyer pushes periodically)
const TRACKING_POLL_INTERVAL = 3_600_000; // 60 minutes
const ORDORO_SYNC_INTERVAL = 300_000; // 5 minutes
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

  if (isManualShipSku(line.sku)) {
    console.log(`  ${tag} — manual shipment required, skipping supplier processing`);
    await markLineManualShip(line.id);
    return;
  }

  if (isInstructionSku(line.sku)) {
    console.log(`  ${tag} — instruction code (I- prefix), skipping supplier processing`);
    await markLineManualShip(line.id);
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
        if (candidate.stock < line.quantity) {
          console.log(`  ${tag} -> ${candidate.supplier} insufficient stock (have ${candidate.stock}, need ${line.quantity}), skipping`);
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
        decision.supplier_product_id = candidate.supplierId;
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
      if (liveResult.stock < line.quantity) {
        console.log(`  ${tag} -> ${candidate.supplier} live stock insufficient (have ${liveResult.stock}, need ${line.quantity}), skipping`);
        continue;
      }
      console.log(`  ${tag} -> live verified ${candidate.supplier} (stock: ${liveResult.stock}, cost: $${liveCost})`);
      decision.chosen_supplier = candidate.supplier;
      decision.supplier_cost = liveCost;
      decision.supplier_stock = liveResult.stock;
      decision.supplier_product_id = candidate.supplierId;
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

    // place orders for decided lines
    try {
      await placeOrders();
    } catch (orderErr) {
      console.error("[order] Error in placeOrders:", orderErr.message);
    }
  } catch (err) {
    console.error("[poll] Top-level error:", err.message);
  } finally {
    pollRunning = false;
  }
}

// ── Order Placement ─────────────────────────────────────

const SUPPLIER_PLACE_FN = {
  turn14: turn14.placeOrder,
  ekeystone: ekeystone.placeOrder,
  meyer: meyer.placeOrder,
};

const ADDRESS_MAP_FN = {
  turn14: mapAddressForTurn14,
  ekeystone: mapAddressForEkeystone,
  meyer: mapAddressForMeyer,
};

function isTransientError(err) {
  if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(err.code)) return true;
  if ([429, 500, 502, 503, 504].includes(err.response?.status)) return true;
  if (err.message?.includes("timed out")) return true;
  return false;
}

async function placeOrders() {
  if (process.env.ORDER_PLACEMENT_ENABLED !== "true") return;

  const groups = await getDecidedLinesGrouped();
  if (groups.size === 0) return;

  console.log(`[order] ${groups.size} batch(es) ready to place`);

  for (const [key, lines] of groups) {
    const [orderId, supplier] = key.split("__");
    const tag = `Order #${orderId} -> ${supplier} (${lines.length} items)`;

    try {
      // idempotency: skip if a non-failed supplier_order already exists
      const existing = await existingSupplierOrder(orderId, supplier);
      if (existing) {
        console.log(`  ${tag} — already has PO ${existing.po_number}, skipping`);
        continue;
      }

      // claim all lines atomically (decided -> ordering)
      const claims = await Promise.all(lines.map((l) => claimLineForOrdering(l.id)));
      if (claims.some((c) => !c)) {
        console.log(`  ${tag} — some lines already claimed, skipping`);
        continue;
      }

      // get shipping address
      const shippingAddress = await getOrderShippingAddress(orderId);
      if (!shippingAddress) {
        throw new Error("No shipping address found for order");
      }

      // generate PO number
      const poNumber = `OMS-${orderId}-${supplier}-${Math.floor(Date.now() / 1000)}`;

      // build items array
      const items = lines.map((l) => ({
        lineId: l.id,
        sku: l.sku,
        mpn: l.mpn,
        supplierId: l.supplier_product_id,
        quantity: l.quantity,
        cost: l.supplier_cost,
      }));

      const totalCost = items.reduce((s, i) => s + (i.cost || 0) * i.quantity, 0);

      // create supplier_orders row
      const supplierOrderId = await createSupplierOrder({
        orderId,
        supplier,
        poNumber,
        shippingAddress,
        items,
        totalCost,
      });

      // link lines to supplier order
      await linkLinesToSupplierOrder(
        lines.map((l) => l.id),
        supplierOrderId,
        poNumber
      );

      // map address to supplier format
      const mappedAddress = ADDRESS_MAP_FN[supplier](shippingAddress);

      if (process.env.DRY_RUN === "true") {
        console.log(`  ${tag} — DRY RUN (PO: ${poNumber}), skipping API call`);
        await markSupplierOrderPlaced(supplierOrderId, `DRY-${poNumber}`);
      } else {
        // place with supplier
        const placeFn = SUPPLIER_PLACE_FN[supplier];
        if (!placeFn) throw new Error(`No placeOrder function for supplier: ${supplier}`);

        const result = await placeFn({
          poNumber,
          items,
          shippingAddress: mappedAddress,
        });

        await markSupplierOrderPlaced(supplierOrderId, result.externalOrderId, result.quoteId);
        console.log(`  ${tag} — placed (PO: ${poNumber}, ext: ${result.externalOrderId})`);
      }

      // mark all lines as ordered
      for (const l of lines) {
        await markLineOrdered(l.id, poNumber);
      }
    } catch (err) {
      console.error(`  ${tag} — FAILED: ${err.message}`);
      const retry = isTransientError(err);
      for (const l of lines) {
        await markLineFailed(l.id, `order placement failed: ${err.message}`, retry);
      }
      // mark the supplier_order as failed so it doesn't block future attempts
      try {
        const existingSo = await existingSupplierOrder(orderId, supplier);
        if (existingSo) await markSupplierOrderFailed(existingSo.id, err.message);
      } catch (_) {}
      try {
        await alertOrderPlacementFailed(orderId, supplier, lines, err);
      } catch (alertErr) {
        console.error(`  [alert] Failed to send placement alert: ${alertErr.message}`);
      }
    }
  }
}

// ── Tracking Poll ───────────────────────────────────────

const SUPPLIER_TRACKING_FN = {
  turn14: turn14.getTracking,
  meyer: meyer.getTracking,
};

async function pollTracking() {
  try {
    const orders = await getOrdersAwaitingTracking();
    if (orders.length === 0) return;

    console.log(`[tracking] Checking ${orders.length} order(s) for tracking updates`);

    // eKeystone: batch lookup via date-range query
    let ekTrackingMap = null;

    for (const so of orders) {
      try {
        let trackingInfo = null;

        if (so.supplier === "ekeystone") {
          // lazy-load eKeystone bulk tracking once per poll
          if (!ekTrackingMap) {
            const bulk = await ekeystone.getTrackingBulk();
            ekTrackingMap = new Map(bulk.map((t) => [t.externalOrderId, t]));
          }
          trackingInfo = ekTrackingMap.get(so.external_order_id) || null;
        } else {
          const fn = SUPPLIER_TRACKING_FN[so.supplier];
          if (fn) trackingInfo = await fn(so.external_order_id);
        }

        if (!trackingInfo?.trackingNumber) continue;

        // update all lines linked to this supplier order
        const soLines = await getLinesForSupplierOrder(so.id);
        let shippedCount = 0;
        for (const line of soLines) {
          if (line.status === "shipped") {
            shippedCount++;
            continue;
          }
          await updateLineTracking(line.id, {
            trackingNumber: trackingInfo.trackingNumber,
            trackingCarrier: trackingInfo.carrier,
          });
          shippedCount++;
        }

        if (shippedCount === soLines.length) {
          await markSupplierOrderShipped(so.id);
          console.log(`[tracking] ${so.po_number} fully shipped (${trackingInfo.trackingNumber})`);
        } else {
          await markSupplierOrderPartiallyShipped(so.id);
        }
      } catch (err) {
        console.error(`[tracking] Error checking ${so.po_number}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("[tracking] Top-level error:", err.message);
  }
}

// ── Ordoro Sync-back ────────────────────────────────────

async function syncTrackingToOrdoro() {
  try {
    const lines = await getUnSyncedShippedLines();
    if (lines.length === 0) return;

    // group by order_id to batch Ordoro API calls
    const byOrder = new Map();
    for (const line of lines) {
      if (!byOrder.has(line.order_id)) byOrder.set(line.order_id, []);
      byOrder.get(line.order_id).push(line);
    }

    console.log(`[ordoro-sync] Syncing tracking for ${byOrder.size} order(s)`);

    for (const [orderId, orderLines] of byOrder) {
      // deduplicate tracking numbers
      const trackingNumbers = [...new Set(orderLines.map((l) => l.tracking_number).filter(Boolean))];

      const syncedTrackingNumbers = new Set();

      for (const trackingNumber of trackingNumbers) {
        try {
          const carrier = orderLines.find((l) => l.tracking_number === trackingNumber)?.tracking_carrier || "";

          await withTimeout(
            axios.post(
              `https://api.ordoro.com/v3/order/${encodeURIComponent(orderId)}/shipping_info/`,
              {
                tracking_number: trackingNumber,
                carrier_name: carrier,
                shipping_method: carrier,
              },
              { headers: { Authorization: `Basic ${auth}` } }
            ),
            ORDORO_API_TIMEOUT,
            `ordoro sync tracking ${orderId}`
          );

          console.log(`[ordoro-sync] Pushed tracking ${trackingNumber} to order #${orderId}`);
          syncedTrackingNumbers.add(trackingNumber);
        } catch (err) {
          // 409/duplicate is fine — tracking already exists in Ordoro
          if (err.response?.status === 409 || err.response?.status === 400) {
            console.log(`[ordoro-sync] Tracking ${trackingNumber} already on order #${orderId}`);
            syncedTrackingNumbers.add(trackingNumber);
          } else {
            console.error(`[ordoro-sync] Failed for order #${orderId}: ${err.message}`);
            continue;
          }
        }
      }

      // only mark lines whose tracking was successfully pushed (or already existed)
      for (const line of orderLines) {
        if (syncedTrackingNumbers.has(line.tracking_number)) {
          await markTrackingSyncedToOrdoro(line.id);
        }
      }
    }
  } catch (err) {
    console.error("[ordoro-sync] Top-level error:", err.message);
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
  const orderPlacement = process.env.ORDER_PLACEMENT_ENABLED === "true";
  const dryRun = process.env.DRY_RUN === "true";

  console.log("=== OMS ===");
  if (orderPlacement) {
    console.log(`Order placement: ENABLED${dryRun ? " (DRY RUN)" : ""}`);
  } else {
    console.log("Order placement: DISABLED (evaluation only)");
  }
  console.log();

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

  // Feed syncs
  if (process.env.EKEYSTONE_FTP_HOST) {
    await syncEkeystone();
    setInterval(syncEkeystone, EKEYSTONE_SYNC_INTERVAL);
  } else {
    console.log("[ekeystone] FTP not configured — skipping feed sync");
  }
  if (process.env.MEYER_SFTP_HOST) {
    await syncMeyer();
    setInterval(syncMeyer, MEYER_SYNC_INTERVAL);
  } else {
    console.log("[meyer] SFTP not configured — skipping feed sync");
  }

  // Poll cycle: fetch orders + decide + place
  await pollCycle();
  setInterval(pollCycle, POLL_INTERVAL);

  // Tracking poll: check suppliers for shipping updates (staggered 1 min)
  if (orderPlacement) {
    setTimeout(async () => {
      await pollTracking();
      setInterval(pollTracking, TRACKING_POLL_INTERVAL);
    }, 60_000);

    // Ordoro sync-back: push tracking numbers (staggered 2 min)
    setTimeout(async () => {
      await syncTrackingToOrdoro();
      setInterval(syncTrackingToOrdoro, ORDORO_SYNC_INTERVAL);
    }, 120_000);
  }
}

main();
