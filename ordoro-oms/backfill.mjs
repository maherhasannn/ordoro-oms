/**
 * One-time backfill script:
 * 0. Re-ingest orders whose lines were lost in the previous failed run
 * 1. Find all is_ds=true order lines
 * 2. Expand any unexpanded kit parents into component rows (with nested kit flattening)
 * 3. Run live supplier checks on all DS lines to populate chosen_supplier
 *
 * SAFE: This does not place any orders — simulation only.
 */
import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { upsertOrder } from "./db.js";
import * as turn14 from "./suppliers/turn14.js";
import * as meyer from "./suppliers/meyer.js";
import * as ekeystone from "./suppliers/ekeystone.js";
import { selectBestDeal } from "./lib/bestDeal.js";

const auth = Buffer.from(`${process.env.ORDORO_CLIENT}:${process.env.ORDORO_SECRET}`).toString("base64");
const ordoroHeaders = { Authorization: `Basic ${auth}` };
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const LIVE_CHECK_FN = { turn14: turn14.liveCheck, meyer: meyer.liveCheck, ekeystone: ekeystone.liveCheck };

async function fetchKitComponents(sku) {
  const res = await axios.get(
    `https://api.ordoro.com/product/${encodeURIComponent(sku)}/`,
    { headers: ordoroHeaders }
  );
  const components = res.data.kit_components || [];
  return components.map((c) => ({
    componentSku: c.sku,
    quantity: c.quantity,
    isKitParent: c.is_kit_parent === true,
  }));
}

async function main() {
  console.log("=== Backfill Script (Simulation Only) ===\n");

  // ── Phase 0: Re-ingest orders with missing lines ────────
  console.log("── Phase 0: Re-ingest orders with missing lines ──\n");

  // Find orders that exist but have zero lines
  const { data: allOrders } = await supabase
    .from("orders")
    .select("id")
    .order("order_date", { ascending: false });

  const emptyOrders = [];
  for (const o of allOrders) {
    const { count } = await supabase
      .from("order_lines")
      .select("*", { count: "exact", head: true })
      .eq("order_id", o.id);
    if (count === 0) emptyOrders.push(o.id);
  }

  if (emptyOrders.length > 0) {
    console.log(`  Found ${emptyOrders.length} orders with 0 lines: ${emptyOrders.join(", ")}`);
    console.log("  Re-fetching from Ordoro and re-upserting...\n");

    for (const orderId of emptyOrders) {
      try {
        const res = await axios.get(
          `https://api.ordoro.com/v3/order/${encodeURIComponent(orderId)}/`,
          { headers: ordoroHeaders }
        );
        const kitExpansions = await upsertOrder(res.data, fetchKitComponents);
        const lineCount = (res.data.lines || []).length;
        const kitInfo = kitExpansions.length > 0
          ? ` (${kitExpansions.map(k => `kit ${k.kitSku}: ${k.dsCount} DS + ${k.warehouseCount} WH`).join(", ")})`
          : "";
        console.log(`  ${orderId}: re-ingested ${lineCount} line(s)${kitInfo}`);
      } catch (e) {
        if (e.response?.status === 404) {
          console.log(`  ${orderId}: 404 — order no longer exists in Ordoro, skipping`);
        } else {
          console.log(`  ${orderId}: ERROR — ${e.message}`);
        }
      }
    }
  } else {
    console.log("  No orders with missing lines.\n");
  }

  // ── Phase 1: Expand any remaining unexpanded kit parents ─
  console.log("\n── Phase 1: Kit Expansion (remaining unexpanded) ──\n");

  const { data: dsLines } = await supabase
    .from("order_lines")
    .select("*")
    .eq("is_ds", true)
    .is("kit_parent_sku", null) // not already a component
    .order("id", { ascending: true });

  let expandedCount = 0;
  for (const line of (dsLines || [])) {
    // Check if it's a kit parent in Ordoro
    let productInfo;
    try {
      const res = await axios.get(
        `https://api.ordoro.com/product/${encodeURIComponent(line.sku)}/`,
        { headers: ordoroHeaders }
      );
      productInfo = res.data;
    } catch (e) {
      console.log(`  ${line.order_id} | ${line.sku} — can't fetch product: ${e.message}`);
      continue;
    }

    if (productInfo.is_kit_parent !== true) continue; // not a kit — skip to Phase 2

    const components = (productInfo.kit_components || []).map((c) => ({
      componentSku: c.sku,
      quantity: c.quantity,
      isKitParent: c.is_kit_parent === true,
    }));

    if (components.length === 0) continue;

    console.log(`  ${line.order_id} | ${line.sku} — KIT with ${components.length} components`);

    // Flatten nested kits
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
          console.log(`    nested kit ${comp.componentSku} -> ${subComps.length} sub-components`);
        } catch (e) {
          console.log(`    nested kit ${comp.componentSku} FAILED: ${e.message}`);
        }
      } else {
        flatComponents.push(comp);
      }
    }

    // Check if already expanded (idempotency)
    const { data: existing } = await supabase
      .from("order_lines")
      .select("id")
      .eq("order_id", line.order_id)
      .eq("kit_parent_sku", line.sku)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`    already expanded — skipping`);
      continue;
    }

    // Insert component rows
    const now = new Date().toISOString();
    let dsCount = 0, whCount = 0;

    for (let c = 0; c < flatComponents.length; c++) {
      const comp = flatComponents[c];
      const compMpn = extractMpn(comp.componentSku);
      const compIsDs = await isComponentDropShip(compMpn);

      if (compIsDs) dsCount++;
      else whCount++;

      const compOrdoroLineId = line.ordoro_line_id
        ? `${line.ordoro_line_id}-comp-${c}`
        : null;

      await supabase.from("order_lines").insert({
        order_id: line.order_id,
        line_number: line.line_number,
        ordoro_line_id: compOrdoroLineId,
        sku: comp.componentSku,
        mpn: compMpn,
        product_name: line.product_name,
        quantity: (line.quantity || 1) * (comp.quantity || 1),
        unit_price: null,
        status: compIsDs ? "pending" : "manual",
        is_ds: compIsDs,
        kit_parent_sku: line.sku,
        updated_at: now,
      });
    }

    // Mark parent line as expanded (never delete)
    await supabase.from("order_lines").update({
      status: "expanded",
      is_ds: false,
      updated_at: now,
    }).eq("id", line.id);
    console.log(`    -> ${dsCount} DS + ${whCount} warehouse components (parent marked expanded)`);
    expandedCount++;
  }

  if (expandedCount === 0) console.log("  No unexpanded kit parents found.");

  // ── Phase 2: Supplier checks on all pending DS lines ────
  console.log("\n── Phase 2: Supplier Checks ──\n");

  const { data: pendingDs } = await supabase
    .from("order_lines")
    .select("*")
    .eq("is_ds", true)
    .eq("status", "pending")
    .order("id", { ascending: true });

  console.log(`Found ${(pendingDs || []).length} pending DS lines to check\n`);

  let successCount = 0, failCount = 0;

  for (const line of (pendingDs || [])) {
    const mpn = line.mpn;
    const tag = `${line.order_id} | ${line.sku} (mpn=${mpn}, qty=${line.quantity})`;

    // Look up product_map
    const { data: mapping } = await supabase
      .from("product_map")
      .select("*")
      .eq("mpn", mpn)
      .maybeSingle();

    if (!mapping) {
      await supabase.from("order_lines").update({
        status: "failed",
        decision_reason: "no product mapping",
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", line.id);
      console.log(`  ${tag} -> no product mapping`);
      failCount++;
      continue;
    }

    // Check all suppliers (with live fallback)
    const [t14, ekey, mey] = await Promise.all([
      turn14.checkByMpn(mpn, mapping.turn14_product_id).catch((e) => {
        console.error(`    [turn14] error: ${e.message}`);
        return null;
      }),
      ekeystone.checkByMpn(mpn, mapping.ekeystone_vcpn).catch((e) => {
        console.error(`    [ekeystone] error: ${e.message}`);
        return null;
      }),
      meyer.checkByMpn(mpn, mapping.meyer_sku).catch((e) => {
        console.error(`    [meyer] error: ${e.message}`);
        return null;
      }),
    ]);

    const results = [t14, ekey, mey].filter(Boolean);
    if (results.length === 0) {
      console.log(`  ${tag} -> all supplier checks failed`);
      failCount++;
      continue;
    }

    const decision = selectBestDeal(results, line.quantity);

    // Live verification
    const candidates = results
      .filter((r) => r.stock >= line.quantity && r.supplierId)
      .sort((a, b) => (a.cost || Infinity) - (b.cost || Infinity));

    if (candidates.length > 0) {
      let verified = false;
      for (const candidate of candidates) {
        const liveCheckFn = LIVE_CHECK_FN[candidate.supplier];
        const liveResult = await liveCheckFn(candidate.supplierId);

        if (liveResult.status === "no_api") {
          if (!candidate.cost || candidate.cost <= 0) continue;
          decision.chosen_supplier = candidate.supplier;
          decision.supplier_cost = candidate.cost;
          decision.supplier_stock = candidate.stock;
          decision.decision_reason = `cheapest (cached, no live API)`;
          verified = true;
          break;
        }
        if (liveResult.status === "error") continue;
        if (liveResult.stock >= line.quantity) {
          const liveCost = liveResult.cost || candidate.cost;
          if (!liveCost || liveCost <= 0) continue;
          decision.chosen_supplier = candidate.supplier;
          decision.supplier_cost = liveCost;
          decision.supplier_stock = liveResult.stock;
          decision.decision_reason = `cheapest (live verified)`;
          verified = true;
          break;
        }
      }
      if (!verified) {
        decision.chosen_supplier = null;
        decision.supplier_cost = null;
        decision.supplier_stock = null;
        decision.decision_reason = `all suppliers failed live verification`;
      }
    }

    // Persist
    const now = new Date().toISOString();
    await supabase.from("order_lines").update({
      chosen_supplier: decision.chosen_supplier || null,
      supplier_cost: decision.supplier_cost ?? null,
      supplier_stock: decision.supplier_stock ?? null,
      decision_reason: decision.decision_reason || null,
      decided_at: now,
      updated_at: now,
      status: decision.chosen_supplier ? "decided" : "failed",
    }).eq("id", line.id);

    if (decision.chosen_supplier) {
      console.log(`  ${tag} -> ${decision.chosen_supplier} @ $${decision.supplier_cost} (stock: ${decision.supplier_stock})`);
      successCount++;
    } else {
      console.log(`  ${tag} -> UNFULFILLABLE: ${decision.decision_reason}`);
      failCount++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Orders re-ingested: ${emptyOrders.length}`);
  console.log(`  Kits expanded (Phase 1): ${expandedCount}`);
  console.log(`  Supplier decided: ${successCount}`);
  console.log(`  Failed/unfulfillable: ${failCount}`);
}

// ── Helpers (duplicated from db.js to keep script self-contained) ──

function extractMpn(sku) {
  if (!sku) return null;
  const idx = sku.indexOf("-");
  return idx > 0 ? sku.slice(idx + 1) : sku;
}

async function isComponentDropShip(mpn) {
  if (!mpn) return false;
  const [t14, ekey, mey] = await Promise.all([
    supabase.from("turn14_inventory").select("id").eq("mfr_part_number", mpn).limit(1).maybeSingle(),
    supabase.from("ekeystone_inventory").select("id").eq("mfr_part_number", mpn).limit(1).maybeSingle(),
    supabase.from("meyer_inventory").select("id").eq("mfr_part_number", mpn).limit(1).maybeSingle(),
  ]);
  const { data: mapping } = await supabase.from("product_map").select("mpn").eq("mpn", mpn).maybeSingle();
  return !!(t14.data || ekey.data || mey.data || mapping);
}

main().catch((e) => console.error("Fatal:", e));
