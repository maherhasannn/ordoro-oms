import dotenv from "dotenv";
dotenv.config();
import { createClient } from "@supabase/supabase-js";
import * as turn14 from "./suppliers/turn14.js";
import * as ekeystone from "./suppliers/ekeystone.js";
import * as meyer from "./suppliers/meyer.js";
import { lookupProductMap } from "./db.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const mpns = ["S-F20231", "B1"];

for (const mpn of mpns) {
  console.log(`\n=== MPN: ${mpn} ===`);

  // Check product_map
  const mapping = await lookupProductMap(mpn);
  console.log("product_map:", mapping ? JSON.stringify(mapping) : "NOT FOUND");

  // Check each supplier cache table directly
  const { data: t14 } = await sb.from("turn14_inventory").select("*").eq("mfr_part_number", mpn).limit(3);
  console.log("turn14_inventory:", t14?.length ? JSON.stringify(t14) : "no match");

  const { data: ekey } = await sb.from("ekeystone_inventory").select("*").eq("mfr_part_number", mpn).limit(3);
  console.log("ekeystone_inventory:", ekey?.length ? JSON.stringify(ekey) : "no match");

  const { data: mey } = await sb.from("meyer_inventory").select("*").eq("mfr_part_number", mpn).limit(3);
  console.log("meyer_inventory:", mey?.length ? JSON.stringify(mey) : "no match");

  // Try checkByMpn for each
  const t14Result = await turn14.checkByMpn(mpn, mapping?.turn14_product_id).catch(e => ({ error: e.message }));
  console.log("turn14.checkByMpn:", JSON.stringify(t14Result));

  const ekeyResult = await ekeystone.checkByMpn(mpn, mapping?.ekeystone_vcpn).catch(e => ({ error: e.message }));
  console.log("ekeystone.checkByMpn:", JSON.stringify(ekeyResult));

  const meyResult = await meyer.checkByMpn(mpn, mapping?.meyer_sku).catch(e => ({ error: e.message }));
  console.log("meyer.checkByMpn:", JSON.stringify(meyResult));
}
