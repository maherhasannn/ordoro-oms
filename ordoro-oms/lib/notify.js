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
 * Build and send an alert for an item that doesn't exist at any supplier.
 * For kit components, includes all lines from the entire order.
 */
export async function alertUnfulfillable(line, decision) {
  const isKitComponent = !!line.kit_parent_sku;
  const itemLabel = line.mpn || line.sku || "unknown";

  const subject = isKitComponent
    ? `OMS Alert: Item not found at any supplier — ${itemLabel} (Order #${line.order_id}, kit ${line.kit_parent_sku})`
    : `OMS Alert: Item not found at any supplier — ${itemLabel} (Order #${line.order_id})`;

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

  body.push(``, `Action required: manually source this item or check product mapping.`);

  await sendAlert(subject, body.join("\n"));
}
