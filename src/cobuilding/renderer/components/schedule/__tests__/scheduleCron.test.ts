import {
  intervalToCron, cronToInterval, validateInterval, cronToHuman, snapIntervalToUnit,
  type ScheduleUnit,
} from '../scheduleCron';

/**
 * These functions came out of two components that nothing imported, so they
 * shipped untested for their whole life. The round-trip block is the one that
 * matters: it is what guarantees a task written by the deleted editor still
 * opens correctly in the new panel.
 */

describe('intervalToCron / cronToInterval round-trip', () => {
  const cases: [number, ScheduleUnit][] = [
    [5, 'minutes'], [15, 'minutes'], [55, 'minutes'],
    [1, 'hours'], [6, 'hours'], [24, 'hours'],
    [1, 'days'], [7, 'days'], [31, 'days'],
  ];
  it.each(cases)('%i %s survives a round-trip', (interval, unit) => {
    expect(cronToInterval(intervalToCron(interval, unit))).toEqual({ interval, unit });
  });
});

describe('cronToInterval is total', () => {
  // A settings page must not crash on a row someone hand-edited in scheduling.db.
  it.each([
    '', '   ', 'nonsense', '* * *', '0 0 1 1 1 1 1', '@daily', '*/0 * * * *',
  ])('falls back to 1 hour for %p', (expr) => {
    expect(() => cronToInterval(expr)).not.toThrow();
    const r = cronToInterval(expr);
    expect(r.interval).toBeGreaterThan(0);
    expect(['minutes', 'hours', 'days']).toContain(r.unit);
  });

  it('reads the legacy hourly and daily forms the old editor could write', () => {
    expect(cronToInterval('0 * * * *')).toEqual({ interval: 1, unit: 'hours' });
    expect(cronToInterval('0 0 * * *')).toEqual({ interval: 1, unit: 'days' });
  });
});

describe('validateInterval', () => {
  it('refuses a sub-5-minute cadence — every run is a paid chat turn', () => {
    expect(validateInterval(1, 'minutes')).toBeTruthy();
    expect(validateInterval(4, 'minutes')).toBeTruthy();
    expect(validateInterval(5, 'minutes')).toBeNull();
  });

  it('refuses non-multiples of 5 and out-of-range minutes', () => {
    expect(validateInterval(7, 'minutes')).toBe('Must be a multiple of 5');
    expect(validateInterval(60, 'minutes')).toBeTruthy();
  });

  it('bounds hours and days to what the cron field can express', () => {
    expect(validateInterval(24, 'hours')).toBeNull();
    expect(validateInterval(25, 'hours')).toBeTruthy();
    expect(validateInterval(31, 'days')).toBeNull();
    expect(validateInterval(32, 'days')).toBeTruthy();
  });

  it.each([0, -1, 1.5, NaN])('refuses %p', (n) => {
    expect(validateInterval(n as number, 'hours')).toBeTruthy();
  });

  it('accepts everything intervalToCron round-trips, and vice versa', () => {
    for (const unit of ['minutes', 'hours', 'days'] as ScheduleUnit[]) {
      for (let i = 1; i <= 60; i++) {
        if (validateInterval(i, unit) === null) {
          expect(cronToInterval(intervalToCron(i, unit))).toEqual({ interval: i, unit });
        }
      }
    }
  });
});

describe('cronToHuman', () => {
  it('describes the shapes the editor produces', () => {
    expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronToHuman('0 */6 * * *')).toBe('Every 6 hours');
    expect(cronToHuman('0 0 */3 * *')).toBe('Every 3 days');
    expect(cronToHuman('0 0 */1 * *')).toBe('Daily');
    expect(cronToHuman('0 */1 * * *')).toBe('Every hour');
  });

  it('returns the raw expression rather than guessing at one it cannot model', () => {
    expect(cronToHuman('15 3 * * 1')).toBe('15 3 * * 1');
    expect(cronToHuman('nonsense')).toBe('nonsense');
  });

  it('never returns an empty string for a valid schedule', () => {
    for (const unit of ['minutes', 'hours', 'days'] as ScheduleUnit[]) {
      for (const i of [5, 10, 20]) {
        if (validateInterval(i, unit) === null) {
          expect(cronToHuman(intervalToCron(i, unit)).trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('snapIntervalToUnit', () => {
  it('always lands on a value validateInterval accepts', () => {
    for (const unit of ['minutes', 'hours', 'days'] as ScheduleUnit[]) {
      for (const raw of [0, 1, 3, 7, 30, 55, 100]) {
        expect(validateInterval(snapIntervalToUnit(raw, unit), unit)).toBeNull();
      }
    }
  });
});
