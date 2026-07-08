import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const auth = Buffer.from(
  `${process.env.ORDORO_CLIENT}:${process.env.ORDORO_SECRET}`
).toString("base64");

async function test() {
  // Find an already-synced shipped line with tracking
  const { data: lines, error } = await supabase
    .from("order_lines")
    .select("id, order_id, tracking_number, tracking_carrier, shipped_at")
    .eq("status", "shipped")
    .eq("tracking_synced_to_ordoro", true)
    .not("tracking_number", "is", null)
    .limit(1);

  if (error) {
    console.error("Supabase query failed:", error.message);
    process.exit(1);
  }

  if (!lines || lines.length === 0) {
    console.log("No already-synced shipped lines found — nothing to test with.");
    process.exit(0);
  }

  const line = lines[0];
  console.log(`Testing with order #${line.order_id}, tracking: ${line.tracking_number}`);

  try {
    const resp = await axios.post(
      `https://api.ordoro.com/v3/order/${encodeURIComponent(line.order_id)}/shipping_info`,
      {
        tracking_number: line.tracking_number,
        carrier_name: line.tracking_carrier || "",
        shipping_method: line.tracking_carrier || "",
        cost: 0,
        ship_date: line.shipped_at || new Date().toISOString(),
        notify_bill_to: false,
        notify_ship_to: false,
        notify_cart: true,
      },
      {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 15_000,
      }
    );
    console.log(`SUCCESS (${resp.status}) — tracking accepted (new or re-accepted)`);
    console.log("Response:", JSON.stringify(resp.data, null, 2));
  } catch (err) {
    if (err.response?.status === 409) {
      console.log(`PASS — Got 409 (tracking already exists in Ordoro). Write path works.`);
    } else {
      console.error(`FAIL — Unexpected error: ${err.response?.status || err.message}`);
      if (err.response?.data) console.error("Body:", JSON.stringify(err.response.data, null, 2));
      process.exit(1);
    }
  }
}

test();
