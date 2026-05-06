import nodemailer from "nodemailer";

let transporter = null;

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
 * Build and send an alert for an unfulfillable order line.
 */
export async function alertUnfulfillable(line, decision) {
  const isKitComponent = !!line.kit_parent_sku;
  const itemLabel = line.mpn || line.sku || "unknown";
  const subject = isKitComponent
    ? `OMS Alert: Cannot fulfill kit component ${itemLabel} (Order #${line.order_id}, kit ${line.kit_parent_sku})`
    : `OMS Alert: Cannot fulfill ${itemLabel} (Order #${line.order_id})`;

  const supplierBreakdown = (decision.allResults || [])
    .map(
      (r) =>
        `  - ${r.supplier}: ${r.stock} in stock @ $${r.cost}/unit`
    )
    .join("\n");

  const lines = [
    `Order:    #${line.order_id}`,
  ];

  if (isKitComponent) {
    lines.push(`Kit SKU:  ${line.kit_parent_sku}`);
    lines.push(`Component SKU: ${line.sku || "N/A"}`);
  } else {
    lines.push(`SKU:      ${line.sku || "N/A"}`);
  }

  lines.push(
    `MPN:      ${line.mpn || "N/A"}`,
    `Product:  ${line.product_name || "N/A"}`,
    `Qty needed: ${line.quantity}`,
    `Min stock required: ${Math.max(line.quantity, 4)} (includes buffer of 4)`,
    ``,
    `Reason: ${decision.decision_reason}`,
    ``,
    `Supplier inventory at time of check:`,
    supplierBreakdown || "  (no suppliers checked)",
    ``,
    `Action required: manually source this item or wait for restock.`,
  );

  await sendAlert(subject, lines.join("\n"));
}
