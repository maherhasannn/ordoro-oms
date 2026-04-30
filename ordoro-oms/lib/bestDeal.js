const MIN_STOCK_BUFFER = 4;

/**
 * Pick the cheapest supplier that has enough stock.
 * Requires at least max(requiredQty, 4) units to ensure a safety buffer.
 *
 * @param {Array<{supplier: string, stock: number, cost: number}>} results
 * @param {number} requiredQty
 * @returns {{ chosen_supplier, supplier_cost, supplier_stock, decision_reason, allResults }}
 */
export function selectBestDeal(results, requiredQty) {
  const minStock = Math.max(requiredQty, MIN_STOCK_BUFFER);

  // filter to suppliers with enough stock (including buffer)
  const inStock = results.filter(
    (r) => r.stock >= minStock && r.cost > 0
  );

  if (inStock.length === 0) {
    // build a summary of what each supplier had
    const detail = results
      .map((r) => `${r.supplier}: ${r.stock} in stock @ $${r.cost}`)
      .join("; ");

    return {
      chosen_supplier: null,
      supplier_cost: null,
      supplier_stock: null,
      decision_reason: `insufficient stock everywhere (need ${minStock}+): ${detail}`,
      allResults: results,
    };
  }

  // sort by cost ascending
  inStock.sort((a, b) => a.cost - b.cost);

  const best = inStock[0];
  const reason =
    inStock.length === 1
      ? `only ${best.supplier} meets stock threshold (${minStock}+)`
      : `cheapest of ${inStock.length} suppliers with ${minStock}+ stock`;

  return {
    chosen_supplier: best.supplier,
    supplier_cost: best.cost,
    supplier_stock: best.stock,
    decision_reason: reason,
    allResults: results,
  };
}
