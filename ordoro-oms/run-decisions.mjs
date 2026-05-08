/**
 * One-time script: run supplier checks on all is_ds=true pending/failed lines
 * and populate chosen_supplier.
 */
import dotenv from "dotenv";
dotenv.config();
import { createClient } from "@supabase/supabase-js";
import {
  lookupProductMap,
  updateOrderLineDecision,
} from "./db.js";
import * as turn14 from "./suppliers/turn14.js";
import * as ekeystone from "./suppliers/ekeystone.js";
import * as meyer from "./suppliers/meyer.js";
import { selectBestDeal } from "./lib/bestDeal.js";
import { alertUnfulfillable } from "./lib/notify.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const LIVE_CHECK_FN = {
  turn14: turn14.liveCheck,
  meyer: meyer.liveCheck,
  ekeystone: ekeystone.liveCheck,
};

async function checkSupplier(name, fn, mpn, mappedId) {
  try {
    return await fn(mpn, mappedId);
  } catch (err) {
    console.error(`  [${name}] error for MPN ${mpn}: ${err.message}`);
    return null;
  }
}

async function main() {
  // Reset failed DS lines to pending
  await supabase
    .from("order_lines")
    .update({
      status: "pending",
      chosen_supplier: null,
      supplier_cost: null,
      supplier_stock: null,
      decided_at: null,
      decision_reason: null,
      idempotency_key: null,
      updated_at: new Date().toISOString(),
    })
    .eq("is_ds", true)
    .eq("status", "failed");

  // Grab all pending DS lines
  const { data: lines } = await supabase
    .from("order_lines")
    .select("*")
    .eq("is_ds", true)
    .eq("status", "pending")
    .order("id", { ascending: true });

  console.log(`Processing ${(lines || []).length} DS lines\n`);

  let successCount = 0, failCount = 0;

  for (const line of lines || []) {
    const tag = `${line.order_id} | ${line.sku} (mpn=${line.mpn}, qty=${line.quantity})`;

    const mapping = await lookupProductMap(line.mpn);

    const [t14, ekey, mey] = await Promise.all([
      checkSupplier("turn14", turn14.checkByMpn, line.mpn, mapping?.turn14_product_id),
      checkSupplier("ekeystone", ekeystone.checkByMpn, line.mpn, mapping?.ekeystone_vcpn),
      checkSupplier("meyer", meyer.checkByMpn, line.mpn, mapping?.meyer_sku),
    ]);

    const results = [t14, ekey, mey].filter(Boolean);

    if (results.length === 0) {
      console.log(`  ${tag} -> all supplier checks failed`);
      await updateOrderLineDecision(line.id, { chosen_supplier: null, decision_reason: "all supplier checks failed" });
      await alertUnfulfillable(line, { decision_reason: "all supplier checks failed", allResults: [] });
      failCount++;
      continue;
    }

    // Pick cheapest supplier with a known cost (stock doesn't disqualify)
    const decision = selectBestDeal(results, line.quantity);

    // Live verification — try all suppliers with a supplierId
    const candidates = results
      .filter((r) => r.supplierId)
      .sort((a, b) => (a.cost || Infinity) - (b.cost || Infinity));

    if (candidates.length > 0) {
      let verified = false;
      for (const candidate of candidates) {
        const liveCheckFn = LIVE_CHECK_FN[candidate.supplier];
        const liveResult = await liveCheckFn(candidate.supplierId);

        if (liveResult.status === "no_api") {
          if (!candidate.cost || candidate.cost <= 0) continue;
          if (candidate.stock < line.quantity) {
            console.log(`  ${tag} -> ${candidate.supplier} insufficient stock (have ${candidate.stock}, need ${line.quantity}), skipping`);
            continue;
          }
          decision.chosen_supplier = candidate.supplier;
          decision.supplier_cost = candidate.cost;
          decision.supplier_stock = candidate.stock;
          decision.decision_reason = `cheapest (cached, no live API)`;
          verified = true;
          break;
        }
        if (liveResult.status === "error") continue;

        const liveCost = liveResult.cost || candidate.cost;
        if (!liveCost || liveCost <= 0) continue;
        if (liveResult.stock < line.quantity) {
          console.log(`  ${tag} -> ${candidate.supplier} live stock insufficient (have ${liveResult.stock}, need ${line.quantity}), skipping`);
          continue;
        }
        decision.chosen_supplier = candidate.supplier;
        decision.supplier_cost = liveCost;
        decision.supplier_stock = liveResult.stock;
        decision.decision_reason = `cheapest (live verified)`;
        verified = true;
        break;
      }
      if (!verified) {
        decision.chosen_supplier = null;
        decision.supplier_cost = null;
        decision.supplier_stock = null;
        decision.decision_reason = `all suppliers failed live verification`;
      }
    }

    // Persist
    decision.order_id = line.order_id;
    decision.line_number = line.line_number;
    await updateOrderLineDecision(line.id, decision);

    if (decision.chosen_supplier) {
      console.log(`  ${tag} -> ${decision.chosen_supplier} @ $${decision.supplier_cost} (stock: ${decision.supplier_stock})`);
      successCount++;
    } else {
      console.log(`  ${tag} -> FAILED: ${decision.decision_reason}`);
      await alertUnfulfillable(line, decision);
      failCount++;
    }
  }

  console.log(`\nDone: ${successCount} decided, ${failCount} failed`);
}

main().catch((e) => console.error("Fatal:", e));
