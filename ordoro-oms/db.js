import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Orders ──────────────────────────────────────────────

export async function upsertOrder(order) {
  const lines = order.lines || [];
  const tags = (order.tags || []).map((t) => t.text || t);
  const isDs = tags.includes("Contains DS Items");

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

  // upsert each line item
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const sku = l.sku || l.product?.sku || null;
    const mpn = l.product?.mpn || l.product?.upc || sku;

    // use order_id + line_number as logical key (upsert via raw SQL isn't
    // needed — we just insert if not existing, skip if already decided)
    const { data: existing } = await supabase
      .from("order_lines")
      .select("id")
      .eq("order_id", order.order_number)
      .eq("line_number", i)
      .maybeSingle();

    if (!existing) {
      const { error: lineErr } = await supabase.from("order_lines").insert({
        order_id: order.order_number,
        line_number: i,
        sku,
        mpn,
        product_name: l.product?.name || null,
        quantity: l.quantity || 1,
        unit_price: l.unit_price ?? l.item_price ?? null,
        status: "pending",
        is_ds: isDs,
      });
      if (lineErr) throw lineErr;
    }
  }
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

// ── Fulfillment Decision ────────────────────────────────

export async function updateOrderLineDecision(lineId, decision) {
  const update = {
    chosen_supplier: decision.chosen_supplier || null,
    supplier_cost: decision.supplier_cost ?? null,
    supplier_stock: decision.supplier_stock ?? null,
    decision_reason: decision.decision_reason || null,
    decided_at: new Date().toISOString(),
    status: decision.chosen_supplier ? "decided" : "failed",
  };
  if (decision.chosen_supplier && decision.order_id != null && decision.line_number != null) {
    update.idempotency_key = `${decision.order_id}_${decision.line_number}_${decision.chosen_supplier}`;
  }
  const { error } = await supabase
    .from("order_lines")
    .update(update)
    .eq("id", lineId);
  if (error) throw error;
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

export async function getTurn14ByMpn(mpn) {
  const { data, error } = await supabase
    .from("turn14_inventory")
    .select("*")
    .eq("mfr_part_number", mpn)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getEkeystoneByMpn(mpn) {
  const { data, error } = await supabase
    .from("ekeystone_inventory")
    .select("*")
    .eq("mfr_part_number", mpn)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getMeyerByMpn(mpn) {
  const { data, error } = await supabase
    .from("meyer_inventory")
    .select("*")
    .eq("mfr_part_number", mpn)
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
    .update({ status: "ordering" })
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
  const { error } = await supabase
    .from("order_lines")
    .update({
      status: "ordered",
      external_order_id: externalOrderId || null,
    })
    .eq("id", lineId)
    .eq("status", "ordering");
  if (error) throw error;
}

/**
 * Mark a line as failed, or optionally reset to pending for retry.
 */
export async function markLineFailed(lineId, reason, retry = false) {
  const update = {
    status: retry ? "pending" : "failed",
    decision_reason: reason,
  };
  if (retry) {
    // clear previous decision so it can be re-evaluated
    update.chosen_supplier = null;
    update.supplier_cost = null;
    update.supplier_stock = null;
    update.decided_at = null;
    update.idempotency_key = null;
  }
  const { error } = await supabase
    .from("order_lines")
    .update(update)
    .eq("id", lineId);
  if (error) throw error;
}

/**
 * Find lines stuck in 'ordering' for longer than the given threshold.
 * Used for crash recovery on startup.
 */
export async function getStuckOrderingLines(olderThanMinutes = 10) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("order_lines")
    .select("*")
    .eq("status", "ordering")
    .lt("decided_at", cutoff);
  if (error) throw error;
  return data || [];
}

export default supabase;
