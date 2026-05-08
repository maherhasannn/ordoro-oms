/**
 * Pick the cheapest supplier that has a known cost AND sufficient stock.
 * A supplier must have cost > 0 AND stock >= requiredQty to be considered.
 *
 * @param {Array<{supplier: string, stock: number, cost: number}>} results
 * @param {number} requiredQty
 * @returns {{ chosen_supplier, supplier_cost, supplier_stock, decision_reason, allResults }}
 */
export function selectBestDeal(results, requiredQty) {
  // filter to suppliers that have a known cost AND enough stock
  const eligible = results.filter((r) => r.cost > 0 && r.stock >= requiredQty);

  if (eligible.length === 0) {
    const detail = results
      .map((r) => `${r.supplier}: ${r.stock} in stock @ $${r.cost}`)
      .join("; ");

    // Distinguish between "no cost" and "has cost but insufficient stock"
    const hadCost = results.some((r) => r.cost > 0);
    const reasonPrefix = hadCost
      ? `no supplier has enough stock (need ${requiredQty})`
      : `no supplier has a known cost`;

    return {
      chosen_supplier: null,
      supplier_cost: null,
      supplier_stock: null,
      decision_reason: `${reasonPrefix}: ${detail}`,
      allResults: results,
    };
  }

  // sort by cost ascending
  eligible.sort((a, b) => a.cost - b.cost);

  const best = eligible[0];
  const reason =
    eligible.length === 1
      ? `only ${best.supplier} has cost and stock`
      : `cheapest of ${eligible.length} eligible suppliers`;

  return {
    chosen_supplier: best.supplier,
    supplier_cost: best.cost,
    supplier_stock: best.stock,
    decision_reason: reason,
    allResults: results,
  };
}
