/**
 * What a turn, and a whole chat, cost - from the `result` rows the host
 * stores.
 *
 * The SDK's `total_cost_usd` is CUMULATIVE per `query()`: each result carries
 * the running total of that run. A new agent-server session is a new
 * `query()`, so the count starts again; each result row therefore also records
 * the id of the run that produced it (`run_id`). A turn's cost is then the
 * step from the previous costed row of the SAME run, and the first costed row
 * of a run costs its own total.
 *
 * Unknown stays unknown. A row with no usable cost (a host-authored stop, a
 * row from before this was recorded, a crash result with nothing in it)
 * yields `null`, never 0 - the UI renders nothing for it rather than `$0.00`.
 * Pure, so the rules are pinned by tests; the renderer and main both use it.
 */

/** The cost-relevant slice of a stored result row. */
export interface CostRow {
  runId: string | null;
  totalCostUsd: number | null;
}

/** Reads a stored result row's content (parsed JSON) into a `CostRow`. */
export function parseCostRow(content: unknown): CostRow {
  if (typeof content !== 'object' || content === null) return { runId: null, totalCostUsd: null };
  const c = content as { run_id?: unknown; total_cost_usd?: unknown };
  const cost = typeof c.total_cost_usd === 'number' && Number.isFinite(c.total_cost_usd) && c.total_cost_usd >= 0
    ? c.total_cost_usd
    : null;
  const runId = typeof c.run_id === 'string' && c.run_id ? c.run_id : null;
  return { runId, totalCostUsd: cost };
}

/** A row's cost only counts when we also know which run it belongs to. */
function usable(row: CostRow): row is { runId: string; totalCostUsd: number } {
  return row.runId !== null && row.totalCostUsd !== null;
}

/**
 * Per-turn cost for each row, in order. `null` where it cannot be known.
 * A cumulative value that goes DOWN inside a run (the CLI's mid-session
 * /clear resets its total) restarts the count: the row costs its own total.
 */
export function turnCosts(rows: readonly CostRow[]): Array<number | null> {
  const lastByRun = new Map<string, number>();
  return rows.map((row) => {
    if (!usable(row)) return null;
    const prev = lastByRun.get(row.runId);
    lastByRun.set(row.runId, row.totalCostUsd);
    if (prev === undefined || row.totalCostUsd < prev) return row.totalCostUsd;
    return row.totalCostUsd - prev;
  });
}

/**
 * The chat's total: each run's last cumulative value, summed. `null` when no
 * row carries a cost at all (nothing measured - show nothing).
 *
 * A reset inside a run (value went down) would make "last value" undercount;
 * summing the per-turn costs handles that, so the total is that sum.
 */
export function chatTotalCost(rows: readonly CostRow[]): number | null {
  const costs = turnCosts(rows);
  let sum = 0;
  let any = false;
  for (const c of costs) {
    if (c === null) continue;
    sum += c;
    any = true;
  }
  return any ? sum : null;
}

/** `<$0.01`, then two decimals. Missing, non-finite or non-positive -> null (render nothing). */
export function formatCost(usd: number | null | undefined): string | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
