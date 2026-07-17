import { Client as FTPClient } from "basic-ftp";
import { parse } from "csv-parse";
import { createReadStream, createWriteStream } from "fs";
import { unlink, stat } from "fs/promises";
import { createInterface } from "readline";
import { tmpdir } from "os";
import { join } from "path";
import { upsertEkeystoneInventory, getEkeystoneInventory, getEkeystoneByMpn } from "../db.js";
import { withTimeout } from "../lib/timeout.js";

const LOCAL_FILE = join(tmpdir(), "ekeystone-feed.csv");
const EKEYSTONE_FEED_TIMEOUT = 300_000; // 5 minutes
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

  const feedSize = (await stat(LOCAL_FILE)).size;
  console.log(`[ekeystone] Feed file: ${(feedSize / 1024 / 1024).toFixed(1)} MB`);

  // Strip Excel-style ="..." quoting line-by-line to a clean file, then stream-parse it.
  // Line-by-line avoids the chunk-boundary bug where ="..." splits across chunks.
  const CLEAN_FILE = LOCAL_FILE + ".clean";
  const rl = createInterface({ input: createReadStream(LOCAL_FILE, "utf-8"), crlfDelay: Infinity });
  const ws = createWriteStream(CLEAN_FILE, "utf-8");
  for await (const line of rl) {
    ws.write(line.replace(/="([^"]*)"/g, "$1") + "\n");
  }
  ws.end();
  await new Promise((resolve, reject) => { ws.on("finish", resolve); ws.on("error", reject); });
  await unlink(LOCAL_FILE);

  const CSV_OPTS = {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  };

  const BATCH = 500;
  let batch = [];
  let total = 0;
  let sampleLogged = false;

  for await (const r of createReadStream(CLEAN_FILE, "utf-8").pipe(parse(CSV_OPTS))) {
    if (!sampleLogged) {
      console.log("[ekeystone] Sample record columns:", Object.keys(r).join(", "));
      sampleLogged = true;
    }

    const vcpn = r["VCPN"] || "";
    if (!vcpn) continue;

    batch.push({
      vcpn,
      mfr_part_number: r["ManufacturerPartNo"] || null,
      stock: parseInt(r["TotalQty"] || "0", 10),
      cost: parseFloat(r["Cost"] || "0"),
      list_price: parseFloat(r["JobberPrice"] || "0"),
    });

    if (batch.length >= BATCH) {
      await upsertEkeystoneInventory(batch);
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await upsertEkeystoneInventory(batch);
    total += batch.length;
  }
  await unlink(CLEAN_FILE);

  if (total === 0) {
    console.warn("[ekeystone] Feed file was empty or unparseable");
    return;
  }

  lastFeedSync = new Date();
  console.log(`[ekeystone] Feed synced — ${total} parts cached`);
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

export async function checkByMpn(mpn, mappedVcpn = null) {
  let row = null;
  if (mappedVcpn) row = await getEkeystoneInventory(mappedVcpn);
  if (!row) row = await getEkeystoneByMpn(mpn);
  if (!row) return { supplier: "ekeystone", stock: 0, cost: 0, supplierId: null, cachedAt: null };
  return {
    supplier: "ekeystone",
    stock: row.stock,
    cost: Number(row.cost) || 0,
    supplierId: row.vcpn,
    cachedAt: row.updated_at || null,
  };
}

export function isFeedSynced() {
  return lastFeedSync !== null;
}

// No live API available for eKeystone
export async function liveCheck(vcpn) {
  return { status: "no_api" };
}

// ── SOAP Helpers ───────────────────────────────────────

import axios from "axios";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

const SOAP_ENDPOINT =
  "https://order.ekeystone.com/WSElectronicOrder/ElectronicOrder.asmx";
const SOAP_NS = "http://eKeystone.com";
const EKEYSTONE_SOAP_TIMEOUT = 30_000;

function buildSoapEnvelope(method, params) {
  const body = {};
  body[method] = { "@_xmlns": SOAP_NS, ...params };
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: true,
  });
  const innerXml = builder.build(body);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
    '  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">',
    "  <soap12:Body>",
    innerXml,
    "  </soap12:Body>",
    "</soap12:Envelope>",
  ].join("\n");
}

async function callSoap(method, params) {
  const envelope = buildSoapEnvelope(method, params);
  const res = await withTimeout(
    axios.post(SOAP_ENDPOINT, envelope, {
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
      },
    }),
    EKEYSTONE_SOAP_TIMEOUT,
    `ekeystone SOAP ${method}`
  );
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const parsed = parser.parse(res.data);
  const body = parsed?.Envelope?.Body;
  return body?.[`${method}Response`]?.[`${method}Result`] || body;
}

// ── Order Placement ────────────────────────────────────

const EKEYSTONE_SERVICE_LEVEL = "U11"; // UPS Ground

function parseStatus(result) {
  const ds =
    result?.diffgram?.NewDataSet ||
    result?.diffgram?.ShippingOptions ||
    result?.ShippingOptions ||
    result || {};
  const statusTable = ds?.Status || {};
  const statusStr =
    statusTable?.Status || (typeof result === "string" ? result : "");
  const partResults = ds?.PartResults || {};
  return { statusStr, partResults };
}

export async function placeOrder({ poNumber, items, shippingAddress }) {
  const apiKey =
    process.env.EKEYSTONE_DROPSHIP_KEY || process.env.EKEYSTONE_API_KEY;
  const accountNo = process.env.EKEYSTONE_ACCOUNT_NO;
  if (!apiKey || !accountNo) {
    throw new Error("eKeystone SOAP credentials not configured (EKEYSTONE_API_KEY / EKEYSTONE_ACCOUNT_NO)");
  }

  const partNumberQuantity = items
    .map((i) => `${i.supplierId},${i.quantity}`)
    .join("|");

  const processMethod = process.env.DRY_RUN === "true" ? 0 : 1;
  const custPO = poNumber.replace(/-ekeystone/, "").slice(0, 20);
  const san = (s) => String(s || "").replace(/&/g, "and");

  const sanitizedAddress = {
    DropShipFirstName: san(shippingAddress.DropShipFirstName),
    DropShipMiddleInitial: san(shippingAddress.DropShipMiddleInitial),
    DropShipLastName: san(shippingAddress.DropShipLastName),
    DropShipCompany: san(shippingAddress.DropShipCompany),
    DropShipAddress1: san(shippingAddress.DropShipAddress1),
    DropShipAddress2: san(shippingAddress.DropShipAddress2),
    DropShipCity: san(shippingAddress.DropShipCity),
    DropShipState: san(shippingAddress.DropShipState),
    DropShipPostalCode: san(shippingAddress.DropShipPostalCode),
    DropShipPhone: san(shippingAddress.DropShipPhone),
    DropShipCountry: san(shippingAddress.DropShipCountry),
    DropShipEmail: san(shippingAddress.DropShipEmail),
  };

  console.log(`[ekeystone] Using ${EKEYSTONE_SERVICE_LEVEL} (UPS Ground) for PO ${custPO}`);

  const result = await callSoap("ShipOrderDropShipMultipleParts", {
    Key: apiKey,
    FullAccountNo: accountNo,
    OrderProcessMethod: processMethod,
    PartNumberQuantity: partNumberQuantity,
    ...sanitizedAddress,
    PONumber: custPO,
    AdditionalInfo: "",
    ServiceLevel: EKEYSTONE_SERVICE_LEVEL,
  });

  const { statusStr, partResults } = parseStatus(result);

  if (!statusStr || statusStr.startsWith("Error")) {
    throw new Error(
      `eKeystone order rejected: ${statusStr || "unknown error"} | ${JSON.stringify(partResults)}`
    );
  }

  const costMatch = statusStr.match(/Shipping=([\d.]+)/);
  const shippingCost = costMatch ? parseFloat(costMatch[1]) : null;

  return {
    externalOrderId: custPO,
    serviceLevel: EKEYSTONE_SERVICE_LEVEL,
    shippingCost,
  };
}

// ── Tracking ───────────────────────────────────────────

const EKSVIA_CARRIER = { "2": "FedEx", "3": "UPS", "6": "Keystone Truck", "7": "Purolator", "8": "USPS" };

export async function getTracking(externalOrderId) {
  const apiKey =
    process.env.EKEYSTONE_DROPSHIP_KEY || process.env.EKEYSTONE_API_KEY;
  const accountNo = process.env.EKEYSTONE_ACCOUNT_NO;
  if (!apiKey || !accountNo) return null;

  try {
    const result = await callSoap("GetOrderHistory", {
      Key: apiKey,
      FullAccountNo: accountNo,
      PONumber: externalOrderId,
      FromDate: "",
      ToDate: "",
    });

    const rows = extractHistoryRows(result);

    for (const row of rows) {
      const tracking = String(row.EKTRCK ?? "").trim();
      if (tracking) {
        return {
          trackingNumber: tracking,
          carrier: EKSVIA_CARRIER[row.EKSVIA] || String(row.EKSVIA ?? "") || null,
          status: String(row.EKSTAT ?? "").trim() || null,
        };
      }
    }

    return null;
  } catch (err) {
    console.error(`[ekeystone] GetOrderHistory (${externalOrderId}) failed: ${err.message}`);
    return null;
  }
}

// Rows live under diffgram.NewDataSet.Table1 (confirmed 2026-07-17); older
// fallbacks kept in case Keystone changes the dataset name again.
function extractHistoryRows(result) {
  const ds = result?.diffgram?.NewDataSet || result?.diffgram?.OrderHistory || result;
  const table = ds?.Table1 || ds?.Table || ds?.Order;
  return Array.isArray(table) ? table : table ? [table] : [];
}

export async function getTrackingBulk() {
  const apiKey =
    process.env.EKEYSTONE_DROPSHIP_KEY || process.env.EKEYSTONE_API_KEY;
  const accountNo = process.env.EKEYSTONE_ACCOUNT_NO;
  if (!apiKey || !accountNo) return [];

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10).replace(/-/g, "");
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateFrom = from.toISOString().slice(0, 10).replace(/-/g, "");

  try {
    const result = await callSoap("GetOrderHistory", {
      Key: apiKey,
      FullAccountNo: accountNo,
      PONumber: "",
      FromDate: dateFrom,
      ToDate: dateTo,
    });

    const rows = extractHistoryRows(result);

    // One order returns a row per status step (RCV ORD → ORDER → PICK →
    // PACKAGE → INVOICE). Only PACKAGE rows carry EKTRCK, so aggregate per PO
    // and never let a later tracking-less row overwrite a found tracking.
    const byPo = new Map();
    for (const o of rows) {
      // .NET encodes "#" as _x0023_ in element names
      const po = String(o.EKORD_x0023_ ?? o["EKORD#"] ?? o.EKPONB ?? o.EKORD ?? "").trim();
      if (!po) continue;
      const tracking = String(o.EKTRCK ?? "").trim();
      const existing = byPo.get(po);
      if (existing?.trackingNumber && !tracking) continue;
      byPo.set(po, {
        externalOrderId: po,
        trackingNumber: tracking || null,
        carrier: EKSVIA_CARRIER[o.EKSVIA] || String(o.EKSVIA ?? "") || null,
        status: String(o.EKSTAT ?? "").trim() || null,
      });
    }
    return [...byPo.values()];
  } catch (err) {
    console.error(`[ekeystone] GetOrderHistory bulk failed: ${err.message}`);
    return [];
  }
}
