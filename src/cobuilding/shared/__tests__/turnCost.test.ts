import { chatTotalCost, formatCost, parseCostRow, turnCosts, type CostRow } from '../turnCost';

const row = (runId: string | null, totalCostUsd: number | null): CostRow => ({ runId, totalCostUsd });

describe('parseCostRow', () => {
  it('reads run id and cumulative cost from a stored result row', () => {
    expect(parseCostRow({ run_id: 'a', total_cost_usd: 0.5, subtype: 'success' })).toEqual(row('a', 0.5));
  });
  it('treats missing, negative and non-numeric values as unknown', () => {
    expect(parseCostRow({ subtype: 'success' })).toEqual(row(null, null));
    expect(parseCostRow({ run_id: 'a', total_cost_usd: -1 })).toEqual(row('a', null));
    expect(parseCostRow({ run_id: 'a', total_cost_usd: '0.5' })).toEqual(row('a', null));
    expect(parseCostRow(null)).toEqual(row(null, null));
  });
});

describe('turnCosts', () => {
  it('is the step between consecutive results of the same run', () => {
    const c = turnCosts([row('a', 0.1), row('a', 0.25), row('a', 0.25)]);
    expect(c[0]).toBeCloseTo(0.1);
    expect(c[1]).toBeCloseTo(0.15);
    expect(c[2]).toBeCloseTo(0);
  });

  it('charges the first result of a run its own total, and restarts when the run changes', () => {
    const c = turnCosts([row('a', 0.5), row('a', 0.7), row('b', 0.2), row('b', 0.5)]);
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.2);
    expect(c[2]).toBeCloseTo(0.2);
    expect(c[3]).toBeCloseTo(0.3);
  });

  it('is unknown, not zero, where a cost is missing - and does not disturb the next delta', () => {
    const c = turnCosts([row('a', 0.4), row('a', null), row('a', 0.9)]);
    expect(c[1]).toBeNull();
    expect(c[2]).toBeCloseTo(0.5);
  });

  it('is unknown for a stopped turn that has no cost (a host-authored stop row)', () => {
    expect(turnCosts([row(null, null)])).toEqual([null]);
  });

  it('is unknown when the run is unknown, since a delta cannot be placed', () => {
    expect(turnCosts([row(null, 0.3)])).toEqual([null]);
  });

  it('treats a cumulative value that drops within a run as a restart of the count', () => {
    const c = turnCosts([row('a', 1.0), row('a', 0.2)]);
    expect(c[1]).toBeCloseTo(0.2);
  });

  it('keeps separate baselines for interleaved runs', () => {
    const c = turnCosts([row('a', 1), row('b', 0.5), row('a', 1.5)]);
    expect(c[2]).toBeCloseTo(0.5);
  });
});

describe('chatTotalCost', () => {
  it("sums each run's last cumulative value", () => {
    expect(chatTotalCost([row('a', 0.5), row('a', 0.7), row('b', 0.2), row('b', 0.5)])).toBeCloseTo(1.2);
  });
  it('ignores unknown rows', () => {
    expect(chatTotalCost([row('a', 0.5), row(null, null), row('a', null)])).toBeCloseTo(0.5);
  });
  it('is null when nothing was measured', () => {
    expect(chatTotalCost([])).toBeNull();
    expect(chatTotalCost([row(null, null), row('a', null)])).toBeNull();
  });
});

describe('formatCost', () => {
  it('renders nothing for unknown or zero', () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(undefined)).toBeNull();
    expect(formatCost(0)).toBeNull();
    expect(formatCost(NaN)).toBeNull();
  });
  it('uses <$0.01 below a cent, then two decimals', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.1449)).toBe('$0.14');
    expect(formatCost(3.4)).toBe('$3.40');
  });
});
