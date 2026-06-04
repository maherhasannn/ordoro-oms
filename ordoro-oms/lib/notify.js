import { createClient } from "@supabase/supabase-js";

let supabase = null;

function getSupabase() {
  if (supabase) return supabase;
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supabase;
}

export async function sendAlert(subject, body) {
  if (!process.env.SMTP2GO_API_KEY || !process.env.ALERT_EMAIL_TO) {
    console.warn(`[alert] (no SMTP2GO key) ${subject}`);
    console.warn(body);
    return;
  }

  try {
    const res = await fetch("https://api.smtp2go.com/v3/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.SMTP2GO_API_KEY,
        sender: process.env.ALERT_EMAIL_FROM,
        to: process.env.ALERT_EMAIL_TO.split(",").map(e => e.trim()),
        subject,
        text_body: body,
      }),
    });
    const data = await res.json();
    if (data.data?.succeeded > 0) {
      console.log(`[alert] Email sent: ${subject}`);
    } else {
      console.error(`[alert] Email failed:`, data);
      console.warn(body);
    }
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

export async function alertSplitOrder(orderId, lines, lineResultsMap, breakdown) {
  const subject = `OMS Alert: No single supplier can fulfill Order #${orderId}`;

  const body = [
    `Order:  #${orderId}`,
    `Lines:  ${lines.length}`,
    ``,
    `No single supplier has stock + cost for every item in this order.`,
    `Manual intervention required — source from one supplier or split manually.`,
    ``,
    `Items in order:`,
  ];

  for (const line of lines) {
    const results = lineResultsMap.get(line.id) || [];
    const available = results
      .filter((r) => r.supplierId && r.cost > 0)
      .map((r) => `${r.supplier} (${r.stock} @ $${r.cost})`)
      .join(", ");
    body.push(`  - ${line.sku} (mpn=${line.mpn}) qty=${line.quantity} — ${available || "no suppliers"}`);
  }

  if (Object.keys(breakdown).length > 0) {
    body.push(``, `Per-supplier gaps:`);
    for (const [supplier, missing] of Object.entries(breakdown)) {
      const skus = missing.map((l) => l.sku).join(", ");
      body.push(`  - ${supplier}: missing ${skus}`);
    }
  }

  body.push(``, `Action: Manually source this order or adjust inventory.`);

  await sendAlert(subject, body.join("\n"));
}

export async function alertHighShippingCost(orderId, supplier, poNumber, shippingCost, serviceLevel, lines) {
  const threshold = Number(process.env.SHIPPING_COST_ALERT_THRESHOLD) || 100;
  if (shippingCost < threshold) return;

  const itemList = lines
    .map((l) => `  - ${l.sku} (mpn=${l.mpn}) qty=${l.quantity}`)
    .join("\n");

  const subject = `OMS Alert: High Shipping Cost — $${shippingCost} on #${orderId} (${supplier})`;
  const body = [
    `Order:          #${orderId}`,
    `Supplier:       ${supplier}`,
    `PO:             ${poNumber}`,
    `Service Level:  ${serviceLevel}`,
    `Shipping Cost:  $${shippingCost}`,
    `Threshold:      $${threshold}`,
    ``,
    `Items:`,
    itemList,
    ``,
    `This was the cheapest available shipping option. Review whether this order's margin justifies the cost.`,
  ].join("\n");

  await sendAlert(subject, body);
}

export async function alertFeedSyncFailed(supplier, error) {
  const subject = `OMS Alert: ${supplier} Inventory Feed Sync Failed`;
  const body = [
    `Supplier: ${supplier}`,
    `Error:    ${error.message || error}`,
    `Time:     ${new Date().toISOString()}`,
    ``,
    `The inventory feed could not be downloaded or parsed. Cached inventory`,
    `data is now stale and orders may be placed against outdated stock levels.`,
    ``,
    `Action: Check ${supplier} FTP/SFTP credentials and connectivity.`,
  ].join("\n");

  await sendAlert(subject, body);
}

export async function alertSuspiciousMpn(orderId, sku, extractedMpn) {
  const subject = `OMS Alert: Suspicious MPN extracted — "${extractedMpn}" from ${sku} (Order #${orderId})`;
  const body = [
    `Order:         #${orderId}`,
    `Component SKU: ${sku}`,
    `Extracted MPN: "${extractedMpn}" (${extractedMpn.length} char)`,
    ``,
    `The MPN extracted from this kit component SKU is suspiciously short`,
    `(under 2 characters). It has been marked as manual to prevent a`,
    `false supplier match.`,
    ``,
    `Action: Verify whether this component should be drop-shipped. If so,`,
    `ensure the SKU follows the BRAND-MPN or BRAND+MPN convention.`,
  ].join("\n");

  await sendAlert(subject, body);
}

export async function alertOrderPlacementFailed(orderId, supplier, lines, error) {
  const itemList = lines
    .map((l) => `  - ${l.sku} (mpn=${l.mpn}) qty=${l.quantity}`)
    .join("\n");

  const isTransient =
    error.code === "ECONNRESET" ||
    error.code === "ETIMEDOUT" ||
    error.message?.includes("timed out") ||
    [429, 500, 502, 503, 504].includes(error.response?.status);

  const subject = `OMS Alert: Order Placement Failed — #${orderId} -> ${supplier}`;
  const body = [
    `Order:     #${orderId}`,
    `Supplier:  ${supplier}`,
    `Error:     ${error.message}`,
    ``,
    `Affected items:`,
    itemList,
    ``,
    isTransient
      ? `This appears transient and will automatically retry.`
      : `Action required: investigate and resolve manually.`,
  ].join("\n");

  await sendAlert(subject, body);
}
