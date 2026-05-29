import dotenv from "dotenv";
dotenv.config();

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MANUAL_SHIP_SKU_PREFIXES = ["JCO", "MXT"];
export const MANUAL_SHIP_DECISION_REASON =
  "manual shipment required for JCO/MXT SKU prefix";

export function isManualShipSku(sku) {
  if (!sku) return false;
  const normalized = String(sku).trim().toUpperCase();
  return MANUAL_SHIP_SKU_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isInstructionSku(sku) {
  if (!sku) return false;
  return /^I-/i.test(String(sku).trim());
}

function getManualShipUpdate(now = new Date().toISOString()) {
  return {
    status: "manual",
    chosen_supplier: null,
    supplier_cost: null,
    supplier_stock: null,
    decided_at: null,
    decision_reason: MANUAL_SHIP_DECISION_REASON,
    idempotency_key: null,
    updated_at: now,
  };
}

export async function markLineManualShip(lineId) {
  const { error } = await supabase
    .from("order_lines")
    .update(getManualShipUpdate())
    .eq("id", lineId);
  if (error) throw error;
}

// ── Kit Helpers ──────────────────────────────────────────

/**
 * Extract manufacturer part number from a component SKU.
 * Convention: "BRAND-MPN" → strips everything before the first hyphen.
 * e.g. "BIL-24-188241" → "24-188241", "RAN-RS55042" → "RS55042"
 * Falls back to the full SKU if no hyphen is found.
 */
function extractMpnFromSku(sku) {
  if (!sku) return null;
  const idx = sku.indexOf("-");
  return idx > 0 ? sku.slice(idx + 1) : sku;
}

/**
 * Check if a component MPN exists at any supplier.
 * Returns true if at least one supplier has a matching record (DS-eligible).
 */
async function isComponentDropShip(mpn) {
  if (!mpn) return false;
  const [t14, ekey, mey] = await Promise.all([
    getTurn14ByMpn(mpn),
    getEkeystoneByMpn(mpn),
    getMeyerByMpn(mpn),
  ]);
  return !!(t14 || ekey || mey);
}

// ── Orders ──────────────────────────────────────────────

export async function upsertOrder(order, fetchKitComponents) {
  const lines = order.lines || [];
  const tags = (Array.isArray(order.tags) ? order.tags : []).map((t) => t.text || t);
  const kitExpansions = []; // returned to caller for logging

  // upsert top-level order
  const { error: orderErr } = await supabase.from("orders").upsert(
    {
      id: order.order_number,
      status: order.status,
      order_date: order.order_placed_date || order.created_date,
      customer_name: order.shipping_address?.name || null,
      shipping_address: order.shipping_address || null,
      raw_payload: order,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
  if (orderErr) throw orderErr;

  const ordoroStatus = (order.status || "").toLowerCase();
  if (ordoroStatus !== "awaiting_fulfillment") {
    return kitExpansions;
  }

  // upsert each line item
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const sku = l.sku || l.product?.sku || null;
    const isKitParent = l.product_is_kit_parent === true || l.product?.is_kit_parent === true;

    // ── Kit expansion ──────────────────────────────────
    if (isKitParent && fetchKitComponents && sku) {
      let components;
      try {
        components = await fetchKitComponents(sku);
      } catch (err) {
        console.error(`[kit] Failed to fetch components for ${sku}: ${err.message} — inserting parent line as fallback`);
        components = null;
      }

      if (components && components.length > 0) {
        // Flatten nested kits: if a component is itself a kit parent,
        // expand it recursively (one level deep — nested-nested kits are rare)
        const flatComponents = [];
        for (const comp of components) {
          if (comp.isKitParent) {
            try {
              const subComps = await fetchKitComponents(comp.componentSku);
              for (const sc of subComps) {
                flatComponents.push({
                  componentSku: sc.componentSku,
                  quantity: (comp.quantity || 1) * (sc.quantity || 1),
                });
              }
              console.log(`[kit] Expanded nested kit ${comp.componentSku} -> ${subComps.length} sub-components`);
            } catch (err) {
              console.error(`[kit] Failed to expand nested kit ${comp.componentSku}: ${err.message} — skipping`);
            }
          } else {
            flatComponents.push(comp);
          }
        }

        // Check if we already expanded this kit (idempotency)
        const { data: existingComponents } = await supabase
          .from("order_lines")
          .select("id")
          .eq("order_id", order.order_number)
          .eq("kit_parent_sku", sku)
          .limit(1);

        if (existingComponents && existingComponents.length > 0) {
          // Already expanded — skip re-expansion
          continue;
        }

        const orderHasDsTag = tags.includes("Contains DS Items");
        let dsCount = 0;
        let warehouseCount = 0;
        const ordoroLineId = l.id != null ? String(l.id) : null;
        const now = new Date().toISOString();

        for (let c = 0; c < flatComponents.length; c++) {
          const comp = flatComponents[c];
          const isInsert = /^I-/i.test(comp.componentSku);
          const compMpn = extractMpnFromSku(comp.componentSku);
          const compIsDs = !orderHasDsTag ? false : isInsert ? false : isManualShipSku(comp.componentSku) ? false : await isComponentDropShip(compMpn);
          const compIsManualShip = isManualShipSku(comp.componentSku);
          const compStatus = compIsDs && !compIsManualShip ? "pending" : "manual";

          if (compStatus === "pending") dsCount++;
          else warehouseCount++;

          const compOrdoroLineId = ordoroLineId
            ? `${ordoroLineId}-comp-${c}`
            : null;

          const { error: compErr } = await supabase.from("order_lines").insert({
            order_id: order.order_number,
            line_number: i,
            ordoro_line_id: compOrdoroLineId,
            sku: comp.componentSku,
            mpn: compMpn,
            product_name: l.product_name || l.product?.name || null,
            quantity: (l.quantity || 1) * (comp.quantity || 1),
            unit_price: null, // kit components don't have individual prices from Ordoro
            status: compStatus,
            is_ds: compIsDs,
            decision_reason: compIsManualShip ? MANUAL_SHIP_DECISION_REASON : null,
            kit_parent_sku: sku,
            updated_at: now,
          });
          if (compErr) throw compErr;
        }

        kitExpansions.push({
          lineIndex: i,
          kitSku: sku,
          dsCount,
          warehouseCount,
        });

        // Insert (or update) the parent kit line itself — marked as "expanded"
        // so it's preserved for traceability but not processed by the decision engine
        const parentOrdoroLineId = l.id != null ? String(l.id) : null;
        let existingParent = null;
        if (parentOrdoroLineId) {
          const { data } = await supabase
            .from("order_lines")
            .select("id, status")
            .eq("order_id", order.order_number)
            .eq("ordoro_line_id", parentOrdoroLineId)
            .maybeSingle();
          existingParent = data;
        }
        if (!existingParent) {
          const { data } = await supabase
            .from("order_lines")
            .select("id, status")
            .eq("order_id", order.order_number)
            .eq("line_number", i)
            .is("kit_parent_sku", null)
            .eq("sku", sku)
            .maybeSingle();
          existingParent = data;
        }

        if (existingParent) {
          // Update existing parent line to "expanded" if not already
          if (existingParent.status !== "expanded") {
            await supabase.from("order_lines")
              .update({ status: "expanded", is_ds: false, updated_at: now })
              .eq("id", existingParent.id);
          }
        } else {
          // Insert new parent line as "expanded"
          const parentMpn = l.product?.mpn || sku;
          await supabase.from("order_lines").insert({
            order_id: order.order_number,
            line_number: i,
            ordoro_line_id: parentOrdoroLineId,
            sku,
            mpn: parentMpn,
            product_name: l.product_name || l.product?.name || null,
            quantity: l.quantity || 1,
            unit_price: l.unit_price ?? l.item_price ?? null,
            status: "expanded",
            is_ds: false,
            updated_at: now,
          });
        }

        continue; // skip the normal line insertion below
      }
      // If component fetch returned empty or failed, fall through to insert parent line
    }

    // ── Normal (non-kit) line ──────────────────────────
    // Ordoro may provide MPN on a nested product object or not at all — fall back to SKU
    const mpn = l.product?.mpn || sku;

    // Ordoro flattens product fields onto the line (product_name, product_tags, shippability)
    const lineTags = (l.product_tags || l.product?.tags || []).map((t) => t.text || t);
    const isInsert = /^I-/i.test(sku);
    const lineIsDs = isInsert
      ? false
      : l.shippability?.is_dropship === true ||
        lineTags.includes("Drop Ship") ||
        lineTags.includes("DS");
    const lineIsManualShip = isManualShipSku(sku);

    // Fix: use Ordoro's line item ID for stable identity (array index is fragile)
    const ordoroLineId = l.id != null ? String(l.id) : null;

    // Look up existing line — prefer ordoro_line_id, fall back to line_number
    let existing = null;
    if (ordoroLineId) {
      const { data } = await supabase
        .from("order_lines")
        .select("id, status, ordoro_line_id")
        .eq("order_id", order.order_number)
        .eq("ordoro_line_id", ordoroLineId)
        .maybeSingle();
      existing = data;
    }
    if (!existing) {
      const { data } = await supabase
        .from("order_lines")
        .select("id, status, ordoro_line_id")
        .eq("order_id", order.order_number)
        .eq("line_number", i)
        .maybeSingle();
      existing = data;
    }

    const now = new Date().toISOString();

    if (existing) {
      // Fix: update mutable fields on pending lines (qty/price may have changed)
      if (existing.status === "pending") {
        const updateFields = {
          sku,
          mpn,
          product_name: l.product_name || l.product?.name || null,
          quantity: l.quantity || 1,
          unit_price: l.unit_price ?? l.item_price ?? null,
          is_ds: lineIsDs,
          updated_at: now,
        };
        if (lineIsManualShip) {
          Object.assign(updateFields, getManualShipUpdate(now));
        }
        // Backfill ordoro_line_id on legacy rows
        if (!existing.ordoro_line_id && ordoroLineId) {
          updateFields.ordoro_line_id = ordoroLineId;
        }
        const { error: updateErr } = await supabase
          .from("order_lines")
          .update(updateFields)
          .eq("id", existing.id);
        if (updateErr) throw updateErr;
      }
    } else {
      const { error: lineErr } = await supabase.from("order_lines").insert({
        order_id: order.order_number,
        line_number: i,
        ordoro_line_id: ordoroLineId,
        sku,
        mpn,
        product_name: l.product_name || l.product?.name || null,
        quantity: l.quantity || 1,
        unit_price: l.unit_price ?? l.item_price ?? null,
        status: lineIsManualShip ? "manual" : "pending",
        is_ds: lineIsDs,
        decision_reason: lineIsManualShip ? MANUAL_SHIP_DECISION_REASON : null,
        updated_at: now,
      });
      if (lineErr) throw lineErr;
    }
  }

  return kitExpansions;
}

// ── Unprocessed Lines ───────────────────────────────────

export async function getUnprocessedLines() {
  const { data, error } = await supabase
    .from("order_lines")
    .select("*")
    .eq("status", "pending")
    .eq("is_ds", true)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── Product Map ─────────────────────────────────────────

export async function lookupProductMap(mpn) {
  if (!mpn) return null;
  const { data, error } = await supabase
    .from("product_map")
    .select("*")
    .eq("mpn", mpn)
    .maybeSingle();
  if (error) throw error;
  return data; // null if not found
}

export async function buildProductMap() {
  console.log("[product_map] Building from synced inventory (chunked)...");

  const PAGE = 1000;
  const UPSERT_BATCH = 500;

  async function processSupplier(table, idCol, targetCol) {
    let offset = 0;
    let lastMpn = null;
    let batch = [];
    let total = 0;

    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(`${idCol}, mfr_part_number, stock`)
        .not("mfr_part_number", "is", null)
        .order("mfr_part_number", { ascending: true })
        .order("stock", { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (data.length === 0) break;

      for (const row of data) {
        if (row.mfr_part_number === lastMpn) continue;
        lastMpn = row.mfr_part_number;

        batch.push({ mpn: row.mfr_part_number, [targetCol]: row[idCol] });
        if (batch.length >= UPSERT_BATCH) {
          const { error: upsertErr } = await supabase
            .from("product_map")
            .upsert(batch, { onConflict: "mpn" });
          if (upsertErr) throw upsertErr;
          total += batch.length;
          batch = [];
        }
      }

      if (data.length < PAGE) break;
      offset += PAGE;
    }

    if (batch.length > 0) {
      const { error: upsertErr } = await supabase
        .from("product_map")
        .upsert(batch, { onConflict: "mpn" });
      if (upsertErr) throw upsertErr;
      total += batch.length;
    }

    return total;
  }

  const t14 = await processSupplier("turn14_inventory", "product_id", "turn14_product_id");
  console.log(`[product_map] Turn14: ${t14} MPNs mapped`);

  const ekey = await processSupplier("ekeystone_inventory", "vcpn", "ekeystone_vcpn");
  console.log(`[product_map] eKeystone: ${ekey} MPNs mapped`);

  const mey = await processSupplier("meyer_inventory", "meyer_sku", "meyer_sku");
  console.log(`[product_map] Meyer: ${mey} MPNs mapped`);

  console.log(`[product_map] Done — processed ${t14 + ekey + mey} supplier mappings`);
}

// ── Fulfillment Decision ────────────────────────────────

export async function updateOrderLineDecision(lineId, decision) {
  const now = new Date().toISOString();
  const update = {
    chosen_supplier: decision.chosen_supplier || null,
    supplier_cost: decision.supplier_cost ?? null,
    supplier_stock: decision.supplier_stock ?? null,
    supplier_product_id: decision.supplier_product_id || null,
    decision_reason: decision.decision_reason || null,
    decided_at: now,
    updated_at: now,
    status: decision.chosen_supplier ? "decided" : "failed",
  };
  if (decision.chosen_supplier) {
    update.idempotency_key = `${lineId}_${decision.chosen_supplier}`;
  }
  const { error } = await supabase
    .from("order_lines")
    .update(update)
    .eq("id", lineId);
  if (error) throw error;
}

export async function setLineDecisionReason(lineId, reason) {
  const { error } = await supabase
    .from("order_lines")
    .update({ decision_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", lineId);
  if (error) throw error;
}

// ── Turn14 Inventory Cache ──────────────────────────────

export async function upsertTurn14Inventory(rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("turn14_inventory")
      .upsert(chunk, { onConflict: "product_id" });
    if (error) throw error;
  }
}

// ── eKeystone Inventory Cache ────────────────────────────

export async function upsertEkeystoneInventory(rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({
      vcpn: r.vcpn,
      mfr_part_number: r.mfr_part_number || null,
      stock: r.stock,
      cost: r.cost,
      list_price: r.list_price,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from("ekeystone_inventory")
      .upsert(chunk, { onConflict: "vcpn" });
    if (error) throw error;
  }
}

export async function getEkeystoneInventory(vcpn) {
  const { data, error } = await supabase
    .from("ekeystone_inventory")
    .select("*")
    .eq("vcpn", vcpn)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── Meyer Inventory Cache ────────────────────────────────

export async function upsertMeyerInventory(rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({
      meyer_sku: r.meyer_sku,
      mfr_part_number: r.mfr_part_number || null,
      stock: r.stock,
      cost: r.cost,
      map_price: r.list_price || null,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from("meyer_inventory")
      .upsert(chunk, { onConflict: "meyer_sku" });
    if (error) throw error;
  }
}

export async function getMeyerInventory(sku) {
  const { data, error } = await supabase
    .from("meyer_inventory")
    .select("*")
    .eq("meyer_sku", sku)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── MPN-based Inventory Lookups ─────────────────────────

// Fix: use .order().limit(1) before .maybeSingle() to handle duplicate MPNs
// without throwing. Picks the row with the highest stock for each MPN.

export async function getTurn14ById(productId) {
  const { data, error } = await supabase
    .from("turn14_inventory")
    .select("*")
    .eq("product_id", productId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getTurn14ByMpn(mpn) {
  const { data, error } = await supabase
    .from("turn14_inventory")
    .select("*")
    .eq("mfr_part_number", mpn)
    .order("stock", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getEkeystoneByMpn(mpn) {
  const { data, error } = await supabase
    .from("ekeystone_inventory")
    .select("*")
    .eq("mfr_part_number", mpn)
    .order("stock", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getMeyerByMpn(mpn) {
  const { data, error } = await supabase
    .from("meyer_inventory")
    .select("*")
    .eq("mfr_part_number", mpn)
    .order("stock", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── Sync State (watermark) ──────────────────────────────

export async function getSyncState(key) {
  const { data, error } = await supabase
    .from("sync_state")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data?.value || null;
}

export async function setSyncState(key, value) {
  const { error } = await supabase.from("sync_state").upsert(
    {
      key,
      value: String(value),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );
  if (error) throw error;
}

// ── State Machine Transitions ────────────────────────────

/**
 * Atomically claim a line for ordering (decided → ordering).
 * Returns true if successfully claimed, false if already claimed by another process.
 */
export async function claimLineForOrdering(lineId) {
  const { data, error } = await supabase
    .from("order_lines")
    .update({ status: "ordering", updated_at: new Date().toISOString() })
    .eq("id", lineId)
    .eq("status", "decided")
    .select("id");
  if (error) throw error;
  return data && data.length > 0;
}

/**
 * Mark a line as ordered (ordering → ordered).
 */
export async function markLineOrdered(lineId, externalOrderId) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("order_lines")
    .update({
      status: "ordered",
      external_order_id: externalOrderId || null,
      ordered_at: now,
      updated_at: now,
    })
    .eq("id", lineId)
    .eq("status", "ordering");
  if (error) throw error;
}

export async function resetStuckOrderingLine(lineId) {
  const { error } = await supabase
    .from("order_lines")
    .update({
      status: "pending",
      chosen_supplier: null,
      supplier_cost: null,
      supplier_stock: null,
      supplier_product_id: null,
      decision_reason: null,
      decided_at: null,
      idempotency_key: null,
      supplier_order_id: null,
      supplier_po_number: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", lineId)
    .eq("status", "ordering");
  if (error) throw error;
}

export async function markLineFailed(lineId, reason) {
  const { error } = await supabase
    .from("order_lines")
    .update({
      status: "failed",
      decision_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", lineId);
  if (error) throw error;
}

/**
 * Find lines stuck in 'ordering' for longer than the given threshold.
 * Used for crash recovery on startup.
 */
export async function getStuckOrderingLines(olderThanMinutes = 10) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  // Fix: use updated_at (set when entering 'ordering') instead of decided_at
  // (set when entering 'decided', which can be much earlier)
  const { data, error } = await supabase
    .from("order_lines")
    .select("*")
    .eq("status", "ordering")
    .lt("updated_at", cutoff);
  if (error) throw error;
  return data || [];
}

// ── Stale Pending Escalation ────────────────────────────

export async function getStalePendingLines(olderThanMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await supabase
    .from("order_lines")
    .select("*")
    .eq("status", "pending")
    .eq("is_ds", true)
    .lt("updated_at", cutoff);
  if (error) throw error;
  return data || [];
}


// ── Order Placement ─────────────────────────────────────

export async function getDecidedLinesGrouped() {
  const { data, error } = await supabase
    .from("order_lines")
    .select("*")
    .eq("status", "decided")
    .eq("is_ds", true)
    .order("order_id", { ascending: true });
  if (error) throw error;

  const groups = new Map();
  for (const line of data || []) {
    const key = `${line.order_id}__${line.chosen_supplier}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  return groups;
}

export async function getOrderShippingAddress(orderId) {
  const { data, error } = await supabase
    .from("orders")
    .select("shipping_address")
    .eq("id", orderId)
    .single();
  if (error) throw error;
  return data?.shipping_address || null;
}

export async function createSupplierOrder({ orderId, supplier, poNumber, shippingAddress, items, totalCost }) {
  const { data, error } = await supabase
    .from("supplier_orders")
    .insert({
      order_id: orderId,
      supplier,
      po_number: poNumber,
      shipping_address: shippingAddress,
      items,
      total_cost: totalCost,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function linkLinesToSupplierOrder(lineIds, supplierOrderId, poNumber) {
  const { error } = await supabase
    .from("order_lines")
    .update({
      supplier_order_id: supplierOrderId,
      supplier_po_number: poNumber,
      updated_at: new Date().toISOString(),
    })
    .in("id", lineIds);
  if (error) throw error;
}

export async function markSupplierOrderPlaced(supplierOrderId, externalOrderId, quoteId = null) {
  const { error } = await supabase
    .from("supplier_orders")
    .update({
      status: "placed",
      external_order_id: externalOrderId,
      quote_id: quoteId,
      placed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", supplierOrderId);
  if (error) throw error;
}

export async function markSupplierOrderFailed(supplierOrderId, errorMessage) {
  const { error } = await supabase
    .from("supplier_orders")
    .update({
      status: "failed",
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", supplierOrderId);
  if (error) throw error;
}

export async function existingSupplierOrder(orderId, supplier) {
  const { data, error } = await supabase
    .from("supplier_orders")
    .select("id, po_number, status")
    .eq("order_id", orderId)
    .eq("supplier", supplier)
    .neq("status", "failed")
    .neq("status", "cancelled")
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── Tracking ────────────────────────────────────────────

export async function getOrdersAwaitingTracking() {
  const { data, error } = await supabase
    .from("supplier_orders")
    .select("*")
    .in("status", ["placed", "partially_shipped"])
    .order("placed_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getLinesForSupplierOrder(supplierOrderId) {
  const { data, error } = await supabase
    .from("order_lines")
    .select("*")
    .eq("supplier_order_id", supplierOrderId);
  if (error) throw error;
  return data || [];
}

export async function updateLineTracking(lineId, { trackingNumber, trackingCarrier }) {
  const { error } = await supabase
    .from("order_lines")
    .update({
      status: "shipped",
      tracking_number: trackingNumber,
      tracking_carrier: trackingCarrier,
      shipped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lineId);
  if (error) throw error;
}

export async function markSupplierOrderShipped(supplierOrderId) {
  const { error } = await supabase
    .from("supplier_orders")
    .update({
      status: "shipped",
      shipped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", supplierOrderId);
  if (error) throw error;
}

export async function markSupplierOrderPartiallyShipped(supplierOrderId) {
  const { error } = await supabase
    .from("supplier_orders")
    .update({
      status: "partially_shipped",
      updated_at: new Date().toISOString(),
    })
    .eq("id", supplierOrderId);
  if (error) throw error;
}

// ── Ordoro Sync-back ────────────────────────────────────

export async function getUnSyncedShippedLines() {
  const { data, error } = await supabase
    .from("order_lines")
    .select("*")
    .eq("status", "shipped")
    .eq("tracking_synced_to_ordoro", false)
    .not("tracking_number", "is", null);
  if (error) throw error;
  return data || [];
}

export async function markTrackingSyncedToOrdoro(lineId) {
  const { error } = await supabase
    .from("order_lines")
    .update({
      tracking_synced_to_ordoro: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", lineId);
  if (error) throw error;
}

export default supabase;
