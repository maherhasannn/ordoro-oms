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
  resetStuckOrderingLine,
  lookupProductMap,
  buildProductMap,
  upsertTurn14Inventory,
  getStalePendingLines,
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
import { alertUnfulfillable, alertSplitOrder, alertOrderPlacementFailed, alertHighShippingCost, alertFeedSyncFailed } from "./lib/notify.js";
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
const MEYER_MAX_CACHE_AGE_MS = 9 * 24 * 60 * 60 * 1000; // 9 days — Meyer updates weekly (Saturdays)
const EKEYSTONE_MAX_CACHE_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours — eKeystone updates daily
const EKEYSTONE_SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours (eKeystone inventory updates daily)
const MEYER_SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours (Meyer pushes weekly on Saturdays, daily sync ensures pickup within a day)
const PRODUCT_MAP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours — rebuild after feeds are fresh
const TURN14_BULK_SYNC_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days
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

// ── Verify a single line against a supplier ────────────

async function verifyLineWithSupplier(line, match, supplier) {
  const liveCheckFn = LIVE_CHECK_FN[supplier];
  const liveResult = await liveCheckFn(match.supplierId);

  if (liveResult.status === "no_api") {
    if (!match.cost || match.cost <= 0) return null;
    if (match.stock < line.quantity) return null;
    const cacheAge = match.cachedAt ? Date.now() - new Date(match.cachedAt).getTime() : Infinity;
    const maxAge = supplier === "meyer" ? MEYER_MAX_CACHE_AGE_MS : EKEYSTONE_MAX_CACHE_AGE_MS;
    if (cacheAge > maxAge) return null;
    return { cost: match.cost, stock: match.stock, supplierId: match.supplierId };
  }

  if (liveResult.status === "error") return null;

  const liveCost = liveResult.cost || match.cost;
  if (!liveCost || liveCost <= 0) return null;
  if (liveResult.stock < line.quantity) return null;
  return { cost: liveCost, stock: liveResult.stock, supplierId: match.supplierId };
}

// ── Process all DS lines for one order as a batch ──────

async function processOrderBatch(dsLines) {
  const orderId = dsLines[0].order_id;
  const tag = `Order #${orderId}`;

  // Filter out manual/instruction SKUs first
  const actionable = [];
  for (const line of dsLines) {
    if (line.status !== "pending") continue;
    if (isManualShipSku(line.sku)) {
      console.log(`  ${tag} line ${line.sku} — manual shipment, skipping`);
      await markLineManualShip(line.id);
      continue;
    }
    if (isInstructionSku(line.sku)) {
      console.log(`  ${tag} line ${line.sku} — instruction code, skipping`);
      await markLineManualShip(line.id);
      continue;
    }
    actionable.push(line);
  }

  if (actionable.length === 0) return;

  console.log(`  ${tag} — evaluating ${actionable.length} DS line(s) for single-supplier fulfillment`);

  // 1. Gather supplier results for each line
  const lineResultsMap = new Map();

  for (const line of actionable) {
    const mapping = await lookupProductMap(line.mpn);
    const checks = [
      checkSupplierByMpn("ekeystone", ekeystone.checkByMpn, line.mpn, mapping?.ekeystone_vcpn),
      checkSupplierByMpn("meyer", meyer.checkByMpn, line.mpn, mapping?.meyer_sku),
    ];
    if (process.env.TURN14_ENABLED !== "false") {
      checks.push(checkSupplierByMpn("turn14", turn14.checkByMpn, line.mpn, mapping?.turn14_product_id));
    }
    const settled = await Promise.all(checks);
    lineResultsMap.set(line.id, settled.filter(Boolean));
  }

  // 2. Find suppliers that can fulfill ALL lines (have cost + stock + product ID)
  const supplierNames = ["ekeystone", "meyer"];
  if (process.env.TURN14_ENABLED !== "false") supplierNames.push("turn14");

  const viable = [];

  for (const supplier of supplierNames) {
    let canFulfillAll = true;
    let totalCost = 0;
    const matches = [];

    for (const line of actionable) {
      const results = lineResultsMap.get(line.id);
      const match = results.find((r) => r.supplier === supplier && r.supplierId && r.cost > 0 && r.stock >= line.quantity);
      if (!match) {
        canFulfillAll = false;
        break;
      }
      totalCost += match.cost * line.quantity;
      matches.push({ line, match });
    }

    if (canFulfillAll) {
      viable.push({ supplier, totalCost, matches });
    }
  }

  viable.sort((a, b) => a.totalCost - b.totalCost);

  if (viable.length === 0) {
    const alreadyAlerted = actionable.every((l) => l.decision_reason?.startsWith("no single supplier"));

    if (!alreadyAlerted) {
      const breakdown = {};
      for (const supplier of supplierNames) {
        const missing = [];
        for (const line of actionable) {
          const results = lineResultsMap.get(line.id);
          const match = results.find((r) => r.supplier === supplier && r.supplierId && r.cost > 0 && r.stock >= line.quantity);
          if (!match) missing.push(line);
        }
        if (missing.length > 0) breakdown[supplier] = missing;
      }

      console.log(`  ${tag} — no single supplier can fulfill all ${actionable.length} line(s), alerting`);
      await alertSplitOrder(orderId, actionable, lineResultsMap, breakdown);

      for (const line of actionable) {
        await markLineFailed(line.id, "no single supplier can fulfill entire order");
      }
    }
    return;
  }

  // 3. Live-verify all lines with cheapest viable supplier, fall back to next
  let chosen = null;

  for (const candidate of viable) {
    let allVerified = true;
    const verified = [];

    for (const { line, match } of candidate.matches) {
      const result = await verifyLineWithSupplier(line, match, candidate.supplier);
      if (!result) {
        console.log(`  ${tag} line ${line.sku} — ${candidate.supplier} failed live verification`);
        allVerified = false;
        break;
      }
      verified.push({ line, ...result });
    }

    if (allVerified) {
      chosen = { supplier: candidate.supplier, lines: verified };
      break;
    }
  }

  if (!chosen) {
    const alreadyAlerted = actionable.every((l) => l.decision_reason?.startsWith("no single supplier"));
    if (!alreadyAlerted) {
      console.log(`  ${tag} — all viable suppliers failed live verification, alerting`);
      await alertSplitOrder(orderId, actionable, lineResultsMap, {});
      for (const line of actionable) {
        await markLineFailed(line.id, "no single supplier passed live verification");
      }
    }
    return;
  }

  // 4. Persist decisions — all lines assigned to the same supplier
  const totalCost = chosen.lines.reduce((s, d) => s + d.cost * d.line.quantity, 0);
  console.log(`  ${tag} -> ${chosen.supplier} for all ${actionable.length} line(s) (total: $${totalCost.toFixed(2)})`);

  for (const { line, cost, stock, supplierId } of chosen.lines) {
    const decision = {
      chosen_supplier: chosen.supplier,
      supplier_cost: cost,
      supplier_stock: stock,
      supplier_product_id: supplierId,
      decision_reason: `single-supplier fulfillment (${chosen.supplier})`,
      order_id: line.order_id,
      line_number: line.line_number,
    };
    await updateOrderLineDecision(line.id, decision);
    console.log(`    ${line.sku} (qty ${line.quantity}) -> $${cost}/unit (stock: ${stock})`);
  }
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

    // process unprocessed lines grouped by order (single-supplier constraint)
    const lines = await getUnprocessedLines();
    if (lines.length > 0) {
      const byOrder = new Map();
      for (const line of lines) {
        if (!byOrder.has(line.order_id)) byOrder.set(line.order_id, []);
        byOrder.get(line.order_id).push(line);
      }
      console.log(`[decide] Processing ${lines.length} unprocessed line(s) across ${byOrder.size} order(s)...`);
      for (const [, orderLines] of byOrder) {
        await processOrderBatch(orderLines);
      }
    }


    // Escalate pending lines stuck for 24+ hours
    try {
      const stale = await getStalePendingLines();
      if (stale.length > 0) {
        console.log(`[escalate] ${stale.length} pending line(s) stuck for 24+ hours — marking failed`);
        for (const line of stale) {
          await markLineFailed(line.id, "stuck in pending for 24+ hours — all supplier checks failing");
          await alertUnfulfillable(line, {
            decision_reason: "stuck in pending — all supplier checks failed repeatedly for 24+ hours",
            allResults: [],
          });
        }
      }
    } catch (escalateErr) {
      console.error("[escalate] Error checking stale pending lines:", escalateErr.message);
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

      if (!shippingAddress.name || !shippingAddress.street1 || !shippingAddress.city || !shippingAddress.state || !shippingAddress.zip) {
        const missing = ["name", "street1", "city", "state", "zip"].filter((f) => !shippingAddress[f]);
        throw new Error(`Incomplete shipping address (missing: ${missing.join(", ")})`);
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

        if (result.shippingCost) {
          try {
            await alertHighShippingCost(orderId, supplier, poNumber, result.shippingCost, result.serviceLevel, lines);
          } catch (_) {}
        }
      }

      // mark all lines as ordered
      for (const l of lines) {
        await markLineOrdered(l.id, poNumber);
      }

    } catch (err) {
      console.error(`  ${tag} — FAILED: ${err.message}`);
      for (const l of lines) {
        await markLineFailed(l.id, `order placement failed: ${err.message}`);
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

// ── Product Map Rebuild ────────────────────────────────

let turn14SyncRunning = false;

async function syncProductMap() {
  if (turn14SyncRunning) {
    console.log("[product_map] Skipping — Turn14 bulk sync in progress (will rebuild after it finishes)");
    return;
  }
  try {
    await buildProductMap();
  } catch (err) {
    console.error("[product_map] Rebuild failed:", err.message);
  }
}

// ── eKeystone Feed Sync ─────────────────────────────────

async function syncEkeystone() {
  try {
    await ekeystone.syncFeed();
  } catch (err) {
    console.error("[ekeystone] Feed sync failed:", err.message);
    try { await alertFeedSyncFailed("eKeystone", err); } catch (_) {}
  }
}

// ── Turn14 Bulk Inventory Sync ─────────────────────────

async function syncTurn14() {
  if (turn14SyncRunning) {
    console.log("[turn14] Bulk sync already running — skipping");
    return;
  }
  turn14SyncRunning = true;
  try {
    await turn14.bulkSync();
    await buildProductMap();
  } catch (err) {
    console.error("[turn14] Bulk sync failed:", err.message);
    try { await alertFeedSyncFailed("Turn14", err); } catch (_) {}
  } finally {
    turn14SyncRunning = false;
  }
}

// ── Meyer SFTP Feed Sync ────────────────────────────────

async function syncMeyer() {
  try {
    await meyer.syncFeed();
  } catch (err) {
    console.error("[meyer] Feed sync failed:", err.message);
    try { await alertFeedSyncFailed("Meyer", err); } catch (_) {}
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
        await resetStuckOrderingLine(line.id);
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

  // Rebuild product_map after feeds are fresh
  await syncProductMap();
  setInterval(syncProductMap, PRODUCT_MAP_INTERVAL);

  // Turn14 bulk sync — runs in background so poll cycle starts immediately
  if (process.env.TURN14_ENABLED !== "false") {
    syncTurn14().catch((err) => console.error("[turn14] Initial bulk sync error:", err.message));
    setInterval(syncTurn14, TURN14_BULK_SYNC_INTERVAL);
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
