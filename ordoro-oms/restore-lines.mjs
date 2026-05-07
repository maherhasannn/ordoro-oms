/**
 * One-time script: restore the 5 order lines that were deleted
 * by the failed backfill run, using raw_payload stored in orders table.
 */
import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { upsertOrder } from "./db.js";

const auth = Buffer.from(`${process.env.ORDORO_CLIENT}:${process.env.ORDORO_SECRET}`).toString("base64");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function fetchKitComponents(sku) {
  const res = await axios.get(
    `https://api.ordoro.com/product/${encodeURIComponent(sku)}/`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const components = res.data.kit_components || [];
  return components.map((c) => ({
    componentSku: c.sku,
    quantity: c.quantity,
    isKitParent: c.is_kit_parent === true,
  }));
}

const ids = ["6-18134", "4-113-4219373-0824269", "5-109943", "1-5504", "2-9423"];

async function main() {
  console.log("=== Restoring 5 deleted order lines ===\n");

  for (const id of ids) {
    const { data: order } = await sb.from("orders").select("raw_payload").eq("id", id).maybeSingle();
    if (!order || !order.raw_payload) {
      console.log(`${id}: no raw_payload — skipping`);
      continue;
    }
    try {
      const kitExpansions = await upsertOrder(order.raw_payload, fetchKitComponents);
      const lineCount = (order.raw_payload.lines || []).length;
      console.log(`${id}: re-upserted ${lineCount} line(s)`);
      for (const exp of kitExpansions) {
        console.log(`  kit ${exp.kitSku}: ${exp.dsCount} DS + ${exp.warehouseCount} warehouse`);
      }
    } catch (e) {
      console.log(`${id}: ERROR — ${e.message}`);
    }
  }

  // Verify
  console.log("\n--- Verification ---");
  for (const id of ids) {
    const { data: lines } = await sb
      .from("order_lines")
      .select("sku, status, is_ds, kit_parent_sku, quantity")
      .eq("order_id", id);
    console.log(`${id}: ${(lines || []).length} lines`);
    for (const l of lines || []) {
      console.log(`  ${l.sku} qty=${l.quantity} status=${l.status} ds=${l.is_ds} parent=${l.kit_parent_sku || "-"}`);
    }
  }
}

main().catch((e) => console.error("Fatal:", e));
