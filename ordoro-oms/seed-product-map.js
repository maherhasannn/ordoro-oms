/**
 * Seed product_map with test rows so the end-to-end flow has data to work with.
 * Usage: npm run seed
 *
 * Edit the SEEDS array below with real MPNs and their supplier IDs.
 */
import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SEEDS = [
  // { mpn, turn14_product_id, ekeystone_vcpn, meyer_sku }
  // Fill in with real product data from your catalog:
  {
    mpn: "EXAMPLE-MPN-001",
    turn14_product_id: "12345",
    ekeystone_vcpn: "ABC123",
    meyer_sku: "MEY-001",
  },
  {
    mpn: "EXAMPLE-MPN-002",
    turn14_product_id: "67890",
    ekeystone_vcpn: null,
    meyer_sku: "MEY-002",
  },
  {
    mpn: "EXAMPLE-MPN-003",
    turn14_product_id: null,
    ekeystone_vcpn: "DEF456",
    meyer_sku: null,
  },
];

async function seed() {
  console.log(`Seeding ${SEEDS.length} product_map rows...`);

  const { error } = await supabase
    .from("product_map")
    .upsert(SEEDS, { onConflict: "mpn" });

  if (error) {
    console.error("Seed failed:", error.message);
    process.exit(1);
  }

  console.log("Done. Product map seeded.");
}

seed();
