import { Client as FTPClient } from "basic-ftp";
import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
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

const SERVICE_LEVELS = [
  "U09", "U01", "U02", "U03", "U04", "U05", "U06", "U07", "U08", "U10",
  "F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09", "F10",
  "K01", "K02", "K03", "K04", "K05",
  "LTL",
];

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

async function findCheapestServiceLevel(apiKey, accountNo, partNumberQuantity, sanitizedAddress) {
  const verifyBase = {
    Key: apiKey,
    FullAccountNo: accountNo,
    OrderProcessMethod: 0,
    PartNumberQuantity: partNumberQuantity,
    ...sanitizedAddress,
    AdditionalInfo: "",
  };

  const results = await Promise.allSettled(
    SERVICE_LEVELS.map(async (sl) => {
      const result = await callSoap("ShipOrderDropShipMultipleParts", {
        ...verifyBase,
        PONumber: `VFY-${sl}-${Date.now()}`.slice(0, 20),
        ServiceLevel: sl,
      });
      const { statusStr } = parseStatus(result);
      if (!statusStr || statusStr.startsWith("Error")) return null;
      const costMatch = statusStr.match(/Shipping=([\d.]+)/);
      const shippingCost = costMatch ? parseFloat(costMatch[1]) : Infinity;
      return { serviceLevel: sl, shippingCost, status: statusStr };
    })
  );

  const valid = results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value)
    .sort((a, b) => a.shippingCost - b.shippingCost);

  if (valid.length === 0) return null;

  console.log(
    `[ekeystone] Shipping options: ${valid.map((v) => `${v.serviceLevel}=$${v.shippingCost}`).join(", ")}`
  );
  return valid[0];
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

  const cheapest = await findCheapestServiceLevel(
    apiKey, accountNo, partNumberQuantity, sanitizedAddress
  );
  if (!cheapest) {
    throw new Error("eKeystone: no valid shipping service level found for this order");
  }

  console.log(
    `[ekeystone] Selected ${cheapest.serviceLevel} ($${cheapest.shippingCost}) for PO ${custPO}`
  );

  const result = await callSoap("ShipOrderDropShipMultipleParts", {
    Key: apiKey,
    FullAccountNo: accountNo,
    OrderProcessMethod: processMethod,
    PartNumberQuantity: partNumberQuantity,
    ...sanitizedAddress,
    PONumber: custPO,
    AdditionalInfo: "",
    ServiceLevel: cheapest.serviceLevel,
  });

  const { statusStr, partResults } = parseStatus(result);

  if (!statusStr || statusStr.startsWith("Error")) {
    throw new Error(
      `eKeystone order rejected: ${statusStr || "unknown error"} | ${JSON.stringify(partResults)}`
    );
  }

  return {
    externalOrderId: custPO,
    serviceLevel: cheapest.serviceLevel,
    shippingCost: cheapest.shippingCost,
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

    const table =
      result?.diffgram?.OrderHistory?.Table ||
      result?.diffgram?.NewDataSet?.Table ||
      result?.Table ||
      result?.Order;
    const rows = Array.isArray(table) ? table : table ? [table] : [];

    for (const row of rows) {
      const tracking = row.EKTRCK;
      if (tracking) {
        return {
          trackingNumber: tracking,
          carrier: EKSVIA_CARRIER[row.EKSVIA] || row.EKSVIA || null,
          status: row.EKSTAT || null,
        };
      }
    }

    return null;
  } catch (err) {
    return null;
  }
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

    const table =
      result?.diffgram?.OrderHistory?.Table ||
      result?.diffgram?.NewDataSet?.Table ||
      result?.Table ||
      result?.Order;
    const rows = Array.isArray(table) ? table : table ? [table] : [];

    return rows.map((o) => ({
      externalOrderId: String(o["EKPONB"] || o["EKORD#"] || o.EKORD || ""),
      trackingNumber: o.EKTRCK || null,
      carrier: EKSVIA_CARRIER[o.EKSVIA] || o.EKSVIA || null,
      status: o.EKSTAT || null,
    }));
  } catch (err) {
    return [];
  }
}
