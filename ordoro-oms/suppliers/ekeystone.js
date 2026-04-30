import { Client as FTPClient } from "basic-ftp";
import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { upsertEkeystoneInventory, getEkeystoneInventory } from "../db.js";
import { withTimeout } from "../lib/timeout.js";

const LOCAL_FILE = join(tmpdir(), "ekeystone-feed.csv");
const EKEYSTONE_FEED_TIMEOUT = 60_000;
let lastFeedSync = null;

// ── FTPS download + parse ───────────────────────────────

export async function syncFeed() {
  const client = new FTPClient();
  client.ftp.verbose = false;

  try {
    await withTimeout(
      (async () => {
        await client.access({
          host: process.env.EKEYSTONE_FTP_HOST,
          user: process.env.EKEYSTONE_FTP_USER,
          password: process.env.EKEYSTONE_FTP_PASS,
          port: Number(process.env.EKEYSTONE_FTP_PORT) || 990,
          secure: "implicit",
          secureOptions: { rejectUnauthorized: false },
        });

        // list files to find the feed — name may vary
        const fileList = await client.list();
        console.log(
          `[ekeystone] FTP files found: ${fileList.map((f) => f.name).join(", ") || "(none)"}`
        );

        // look for a CSV/TXT file (the first generated feed)
        const feedFile = fileList.find(
          (f) =>
            f.type !== 2 && // not a directory
            (/\.csv$/i.test(f.name) || /\.txt$/i.test(f.name))
        );

        if (!feedFile) {
          console.warn(
            "[ekeystone] No feed file found on FTP yet (may take up to 3 business days)"
          );
          return;
        }

        console.log(`[ekeystone] Downloading ${feedFile.name}...`);
        await client.downloadTo(LOCAL_FILE, feedFile.name);
      })(),
      EKEYSTONE_FEED_TIMEOUT,
      "ekeystone FTPS feed download"
    );
  } finally {
    client.close();
  }

  // strip Excel-style ="..." quoting → plain values, then parse CSV
  let raw = readFileSync(LOCAL_FILE, "utf-8");
  raw = raw.replace(/="([^"]*)"/g, "$1");

  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  if (records.length === 0) {
    console.warn("[ekeystone] Feed file was empty or unparseable");
    return;
  }

  console.log(
    "[ekeystone] Sample record columns:",
    Object.keys(records[0]).join(", ")
  );

  // map to our schema using actual eKeystone column names
  // Columns: VCPN, ManufacturerPartNo, Cost, JobberPrice, TotalQty, plus per-warehouse qtys
  const rows = records
    .map((r) => ({
      vcpn: r["VCPN"] || "",
      mfr_part_number: r["ManufacturerPartNo"] || null,
      stock: parseInt(r["TotalQty"] || "0", 10),
      cost: parseFloat(r["Cost"] || "0"),
      list_price: parseFloat(r["JobberPrice"] || "0"),
    }))
    .filter((r) => r.vcpn);

  // upsert to Supabase
  await upsertEkeystoneInventory(rows);
  lastFeedSync = new Date();
  console.log(`[ekeystone] Feed synced — ${rows.length} parts cached`);
}

// ── Check single VCPN ───────────────────────────────────

export async function check(vcpn) {
  // warn if feed hasn't synced or is stale (>26 hrs for daily feed)
  if (lastFeedSync) {
    const age = Date.now() - lastFeedSync.getTime();
    if (age > 26 * 60 * 60 * 1000) {
      console.warn(
        `[ekeystone] WARNING: feed is ${Math.round(age / 3600000)}h stale`
      );
    }
  }

  const row = await getEkeystoneInventory(vcpn);
  if (!row) {
    return { supplier: "ekeystone", stock: 0, cost: 0 };
  }
  return {
    supplier: "ekeystone",
    stock: row.stock,
    cost: Number(row.cost),
  };
}

export function isFeedSynced() {
  return lastFeedSync !== null;
}

// No live API available for eKeystone
export async function liveCheck(vcpn) {
  return { status: "no_api" };
}
