/**
 * What a turn, and a whole chat, cost - from the `result` rows the host
 * stores.
 *
 * The SDK's `total_cost_usd` is cumulative, and on a resume it does NOT start
 * from zero. The SDK documents it: "a resumed or forked session continues from
 * the total its transcript saved, when it has one (so the first result already
 * carries the earlier turns)". Acabox runs most turns as a NEW `query()` that
 * resumes the same SDK session, so consecutive result rows of a chat usually
 * form one rising series regardless of which agent-server run produced them.
 * A turn's cost is therefore the step from the previous costed row, in row
 * order. `run_id` is stored on the row for diagnosis but deliberately not
 * keyed on.
 *
 * A value that goes DOWN is a restart (a fresh SDK session after a context
 * overflow cleared the resume pointer, a /clear, or a legacy transcript with no
 * saved total): that turn costs its own value.
 *
 * Unknown stays unknown. A missing or zero value (crash/startup-error results
 * may carry zeroed totals, and host-authored stop rows carry none) yields
 * `null`, never 0, and does not become the baseline for the next row. The UI
 * renders nothing for null rather than `$0.00`. Pure, so the rules are pinned
 * by tests; the renderer and main both use it.
 */

/** The cost-relevant slice of a stored result row. */
export interface CostRow {
  /** The agent-server run that wrote the row; informational only. */
  runId: string | null;
  totalCostUsd: number | null;
}

/** Reads a stored result row's content (parsed JSON) into a `CostRow`. */
export function parseCostRow(content: unknown): CostRow {
  if (typeof content !== 'object' || content === null) return { runId: null, totalCostUsd: null };
  const c = content as { run_id?: unknown; total_cost_usd?: unknown };
  const cost = typeof c.total_cost_usd === 'number' && Number.isFinite(c.total_cost_usd) && c.total_cost_usd > 0
    ? c.total_cost_usd
    : null;
  const runId = typeof c.run_id === 'string' && c.run_id ? c.run_id : null;
  return { runId, totalCostUsd: cost };
}

/**
 * Per-turn cost for each row, in order. `null` where it cannot be known.
 */
export function turnCosts(rows: readonly CostRow[]): Array<number | null> {
  let prev: number | null = null;
  return rows.map((row) => {
    const v = row.totalCostUsd;
    if (v === null || !Number.isFinite(v) || v <= 0) return null;
    const cost = prev === null || v < prev ? v : v - prev;
    prev = v;
    return cost;
  });
}

/**
 * The chat's total: the sum of the per-turn costs (equivalently, each restart
 * segment's last value). `null` when no row carries a cost at all.
 */
export function chatTotalCost(rows: readonly CostRow[]): number | null {
  let sum = 0;
  let any = false;
  for (const c of turnCosts(rows)) {
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
