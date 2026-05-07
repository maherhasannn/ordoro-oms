import dotenv from "dotenv";
dotenv.config();
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ids = ["6-18134", "4-113-4219373-0824269", "5-109943", "1-5504", "2-9423"];

for (const id of ids) {
  const { data: order } = await sb.from("orders").select("raw_payload").eq("id", id).maybeSingle();
  const line = order.raw_payload.lines[0];
  const sku = line.sku || line.product?.sku || null;
  const mpn = line.product?.mpn || sku;
  const name = line.product_name || line.product?.name || null;
  const qty = line.quantity || 1;
  const price = line.unit_price ?? line.item_price ?? null;
  const ordoroLineId = line.id != null ? String(line.id) : null;
  const isDs = true; // these were all is_ds=true (that's how backfill found them)
  console.log(JSON.stringify({ order_id: id, line_number: 0, sku, mpn, product_name: name, quantity: qty, unit_price: price, ordoro_line_id: ordoroLineId, is_ds: isDs }));
}
