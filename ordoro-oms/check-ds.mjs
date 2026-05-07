import dotenv from "dotenv";
dotenv.config();
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// All component SKUs across the 5 orders (nested kits already flattened)
const skus = [
  // 6-18134 (333450789509)
  "JCO-5336", "I-E5", "Wulf Brand", "SKY-N8060",
  // 4-113-4219373-0824269 (333450791779)
  "I-F1", "WULFPACK",
  // 5-109943 (332655987983)
  "JCO-3+SPCR", "JCO-BLOCKS02", "JCO-SUP", "JCO-5/8HW", "I-B1", "I-A1", "JCO-3+NU", "JCO-SR11",
  "RAN-RS55267", "RAN-RS55254",
  // 1-5504 (333477095561)
  "RAN-RS55042", "RAN-RS55047A",
  // 2-9423 (332529284964)
  "JCO-SMX843013", "JCO-SMXR-10.75", "JCO-1/2-13HW", "JCO-530000", "I-A2",
  "BIL-24-188258", "BIL-24-188241",
];

function extractMpn(sku) {
  if (!sku) return null;
  const idx = sku.indexOf("-");
  return idx > 0 ? sku.slice(idx + 1) : sku;
}

for (const sku of [...new Set(skus)]) {
  const mpn = extractMpn(sku);
  const [t14, ekey, mey] = await Promise.all([
    sb.from("turn14_inventory").select("product_id").eq("mfr_part_number", mpn).limit(1).maybeSingle(),
    sb.from("ekeystone_inventory").select("vcpn").eq("mfr_part_number", mpn).limit(1).maybeSingle(),
    sb.from("meyer_inventory").select("meyer_sku").eq("mfr_part_number", mpn).limit(1).maybeSingle(),
  ]);
  const pm = await sb.from("product_map").select("mpn").eq("mpn", mpn).maybeSingle();
  const isDs = !!(t14.data || ekey.data || mey.data || pm.data);
  console.log(`${sku} -> mpn=${mpn} ds=${isDs}`);
}
