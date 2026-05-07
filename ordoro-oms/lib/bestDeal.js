/**
 * Pick the cheapest supplier that has a known cost.
 * Stock level is informational but does NOT disqualify a supplier.
 * Only suppliers with cost > 0 are considered.
 *
 * @param {Array<{supplier: string, stock: number, cost: number}>} results
 * @param {number} requiredQty
 * @returns {{ chosen_supplier, supplier_cost, supplier_stock, decision_reason, allResults }}
 */
export function selectBestDeal(results, requiredQty) {
  // filter to suppliers that have a known cost
  const withCost = results.filter((r) => r.cost > 0);

  if (withCost.length === 0) {
    const detail = results
      .map((r) => `${r.supplier}: ${r.stock} in stock @ $${r.cost}`)
      .join("; ");

    return {
      chosen_supplier: null,
      supplier_cost: null,
      supplier_stock: null,
      decision_reason: `no supplier has a known cost: ${detail}`,
      allResults: results,
    };
  }

  // sort by cost ascending
  withCost.sort((a, b) => a.cost - b.cost);

  const best = withCost[0];
  const stockNote = best.stock >= requiredQty ? "" : ` (low stock: ${best.stock})`;
  const reason =
    withCost.length === 1
      ? `only ${best.supplier} has a known cost${stockNote}`
      : `cheapest of ${withCost.length} suppliers${stockNote}`;

  return {
    chosen_supplier: best.supplier,
    supplier_cost: best.cost,
    supplier_stock: best.stock,
    decision_reason: reason,
    allResults: results,
  };
}
