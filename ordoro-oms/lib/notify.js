import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

let transporter = null;
let supabase = null;

function getSupabase() {
  if (supabase) return supabase;
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supabase;
}

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    family: 4,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

/**
 * Send an alert email. Falls back to console.warn if SMTP is not configured.
 */
export async function sendAlert(subject, body) {
  const t = getTransporter();
  if (!t || !process.env.ALERT_EMAIL_TO) {
    console.warn(`[alert] (no SMTP) ${subject}`);
    console.warn(body);
    return;
  }

  try {
    await t.sendMail({
      from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
      to: process.env.ALERT_EMAIL_TO,
      subject,
      text: body,
    });
    console.log(`[alert] Email sent: ${subject}`);
  } catch (err) {
    console.error(`[alert] Email failed: ${err.message}`);
    console.warn(body);
  }
}

/**
 * Classify why a line failed so we can tailor the alert.
 */
function classifyFailure(reason) {
  if (!reason) return "unknown";
  if (reason.startsWith("no supplier has enough stock")) return "out_of_stock";
  if (reason.startsWith("no supplier has a known cost")) return "not_found";
  if (reason.startsWith("all suppliers failed live verification")) return "live_verification_failed";
  if (reason === "all supplier checks failed") return "supplier_errors";
  return "unknown";
}

const ALERT_META = {
  not_found: {
    tag: "Item not found at any supplier",
    action: "Check product mapping or manually source this item.",
  },
  out_of_stock: {
    tag: "All suppliers out of stock",
    action: "All suppliers carry this item but none have enough stock. This line will automatically retry when stock is replenished.",
  },
  live_verification_failed: {
    tag: "Supplier verification failed",
    action: "Could not confirm stock/cost via live API for any supplier. This is likely transient and will retry automatically.",
  },
  supplier_errors: {
    tag: "All supplier checks errored",
    action: "Every supplier API call failed. This is likely transient and will retry automatically. If it persists, check API credentials and connectivity.",
  },
  unknown: {
    tag: "Unfulfillable",
    action: "Review the decision reason and manually source this item if needed.",
  },
};

/**
 * Build and send an alert for a line that could not be assigned a supplier.
 * The subject and action vary based on the failure scenario.
 * For kit components, includes all lines from the entire order.
 */
export async function alertUnfulfillable(line, decision) {
  const isKitComponent = !!line.kit_parent_sku;
  const itemLabel = line.mpn || line.sku || "unknown";
  const failureType = classifyFailure(decision.decision_reason);
  const meta = ALERT_META[failureType];

  const orderRef = isKitComponent
    ? `Order #${line.order_id}, kit ${line.kit_parent_sku}`
    : `Order #${line.order_id}`;

  const subject = `OMS Alert: ${meta.tag} — ${itemLabel} (${orderRef})`;

  const supplierBreakdown = (decision.allResults || [])
    .map((r) => `  - ${r.supplier}: ${r.stock} in stock @ $${r.cost}/unit`)
    .join("\n");

  const body = [
    `Order:    #${line.order_id}`,
  ];

  if (isKitComponent) {
    body.push(`Kit SKU:  ${line.kit_parent_sku}`);
    body.push(`Component SKU: ${line.sku || "N/A"}`);
  } else {
    body.push(`SKU:      ${line.sku || "N/A"}`);
  }

  body.push(
    `MPN:      ${line.mpn || "N/A"}`,
    `Product:  ${line.product_name || "N/A"}`,
    `Qty needed: ${line.quantity}`,
    ``,
    `Reason: ${decision.decision_reason}`,
    ``,
    `Supplier check results:`,
    supplierBreakdown || "  (no suppliers checked)",
  );

  // For kit components, include all lines from the order for full context
  if (isKitComponent) {
    try {
      const sb = getSupabase();
      const { data: orderLines } = await sb
        .from("order_lines")
        .select("sku, mpn, quantity, status, is_ds, chosen_supplier, supplier_cost, kit_parent_sku")
        .eq("order_id", line.order_id)
        .order("id", { ascending: true });

      if (orderLines && orderLines.length > 0) {
        body.push(``, `All lines in order #${line.order_id}:`);
        for (const ol of orderLines) {
          const supplier = ol.chosen_supplier
            ? `${ol.chosen_supplier} @ $${ol.supplier_cost}`
            : "(none)";
          body.push(
            `  - ${ol.sku} (mpn=${ol.mpn}) qty=${ol.quantity} ds=${ol.is_ds} status=${ol.status} supplier=${supplier}`
          );
        }
      }
    } catch (err) {
      body.push(``, `(failed to fetch full order lines: ${err.message})`);
    }
  }

  body.push(``, meta.action);

  await sendAlert(subject, body.join("\n"));
}
