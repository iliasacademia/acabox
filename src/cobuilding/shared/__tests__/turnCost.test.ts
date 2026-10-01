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
  it('is the step between consecutive results', () => {
    const c = turnCosts([row('a', 0.1), row('a', 0.25), row('a', 0.25)]);
    expect(c[0]).toBeCloseTo(0.1);
    expect(c[1]).toBeCloseTo(0.15);
    expect(c[2]).toBeCloseTo(0);
  });

  it('continues across runs: a resumed run starts from the saved total, so it is a delta, not the full value', () => {
    const c = turnCosts([row('a', 0.5), row('a', 0.7), row('b', 0.9), row('c', 1.0)]);
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.2);
    expect(c[2]).toBeCloseTo(0.2);
    expect(c[3]).toBeCloseTo(0.1);
  });

  it('treats a drop as a restart: that turn costs its own value', () => {
    const c = turnCosts([row('a', 1.0), row('b', 0.2), row('b', 0.5)]);
    expect(c[1]).toBeCloseTo(0.2);
    expect(c[2]).toBeCloseTo(0.3);
  });

  it('is unknown for a zeroed or missing row, and it does not become the baseline', () => {
    const c = turnCosts([row('a', 0.4), row('a', 0), row('a', null), row('a', 0.9)]);
    expect(c[1]).toBeNull();
    expect(c[2]).toBeNull();
    expect(c[3]).toBeCloseTo(0.5);
  });

  it('is unknown for a stopped turn that has no cost (a host-authored stop row)', () => {
    expect(turnCosts([row(null, null)])).toEqual([null]);
  });

  it('does not present the first costed row after uncosted ones as one turn (it carries the earlier turns)', () => {
    // A chat from before cost tracking: two legacy result rows, then the
    // first tracked turn, whose cumulative 2.0 includes the legacy spend.
    const c = turnCosts([row(null, null), row(null, null), row('a', 2.0), row('b', 2.3)]);
    expect(c[2]).toBeNull();
    expect(c[3]).toBeCloseTo(0.3);
  });
});

describe('chatTotalCost', () => {
  it('is the last value of a continuing series', () => {
    expect(chatTotalCost([row('a', 0.5), row('a', 0.7), row('b', 0.9)])).toBeCloseTo(0.9);
  });
  it('adds each restart segment', () => {
    expect(chatTotalCost([row('a', 0.5), row('a', 0.7), row('b', 0.2), row('b', 0.5)])).toBeCloseTo(1.2);
  });
  it('still counts a legacy chat\'s first costed value, which carries the earlier spend', () => {
    expect(chatTotalCost([row(null, null), row('a', 2.0), row('b', 2.3)])).toBeCloseTo(2.3);
  });
  it('ignores unknown rows', () => {
    expect(chatTotalCost([row('a', 0.5), row(null, null), row('a', 0)])).toBeCloseTo(0.5);
  });
  it('is null when nothing was measured', () => {
    expect(chatTotalCost([])).toBeNull();
    expect(chatTotalCost([row(null, null), row('a', 0)])).toBeNull();
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
