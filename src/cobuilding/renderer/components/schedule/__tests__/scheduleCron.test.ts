import {
  intervalToCron, cronToInterval, validateInterval, cronToHuman, snapIntervalToUnit,
  isLegacyDayOfMonthStep, formatTime, parseTime, DEFAULT_TIME,
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
  ];
  it.each(cases)('%i %s survives a round-trip', (interval, unit) => {
    expect(cronToInterval(intervalToCron(interval, unit))).toMatchObject({ interval, unit });
  });

  it('round-trips daily and weekly times, including midnight and Sunday', () => {
    const at = { hour: 0, minute: 0, weekday: 0 };
    expect(cronToInterval(intervalToCron(1, 'daily', at))).toMatchObject({ unit: 'daily', hour: 0, minute: 0 });
    expect(cronToInterval(intervalToCron(1, 'weekly', at))).toMatchObject({ unit: 'weekly', hour: 0, minute: 0, weekday: 0 });
    const late = { hour: 23, minute: 59, weekday: 6 };
    expect(cronToInterval(intervalToCron(1, 'weekly', late))).toMatchObject({ unit: 'weekly', hour: 23, minute: 59, weekday: 6 });
  });

  it('writes the expected cron for daily and weekly', () => {
    expect(intervalToCron(1, 'daily', { hour: 8, minute: 5, weekday: 1 })).toBe('5 8 * * *');
    expect(intervalToCron(1, 'weekly', { hour: 8, minute: 0, weekday: 1 })).toBe('0 8 * * 1');
  });

  it('can never produce a day-of-month step', () => {
    for (const unit of ['minutes', 'hours', 'daily', 'weekly'] as ScheduleUnit[]) {
      for (const i of [1, 5, 25, 31]) {
        const dom = intervalToCron(i, unit).split(' ')[2];
        expect(dom).toBe('*');
      }
    }
  });

  it('reads cron 7 as Sunday', () => {
    expect(cronToInterval('0 8 * * 7')).toMatchObject({ unit: 'weekly', weekday: 0 });
  });
});

describe('time helpers', () => {
  it('formats and parses <input type="time"> values', () => {
    expect(formatTime(DEFAULT_TIME)).toBe('08:00');
    expect(parseTime('08:00')).toEqual({ hour: 8, minute: 0 });
    expect(parseTime('')).toBeNull();
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
  });
});

describe('legacy day-of-month schedules', () => {
  it('detects the old "every N days" shape only for N > 1', () => {
    expect(isLegacyDayOfMonthStep('0 0 */25 * *')).toBe(true);
    expect(isLegacyDayOfMonthStep('0 0 */1 * *')).toBe(false);
    expect(isLegacyDayOfMonthStep('0 0 * * *')).toBe(false);
    expect(isLegacyDayOfMonthStep('nonsense')).toBe(false);
  });

  it('reads truthfully in the list', () => {
    expect(cronToHuman('0 0 */25 * *')).toBe('Every 25 days of the month (from the 1st)');
    expect(cronToHuman('0 0 */1 * *')).toBe('Daily at 00:00');
    expect(cronToHuman('0 0 * * *')).toBe('Daily at 00:00');
  });

  it('maps */1 to daily at midnight and does not model a larger step', () => {
    expect(cronToInterval('0 0 */1 * *')).toMatchObject({ unit: 'daily', hour: 0, minute: 0 });
    expect(cronToInterval('0 0 */25 * *')).toMatchObject({ interval: 1, unit: 'hours' });
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
    expect(['minutes', 'hours', 'daily', 'weekly']).toContain(r.unit);
  });

  it('reads the legacy hourly and daily forms the old editor could write', () => {
    expect(cronToInterval('0 * * * *')).toMatchObject({ interval: 1, unit: 'hours' });
    expect(cronToInterval('0 0 * * *')).toMatchObject({ unit: 'daily', hour: 0, minute: 0 });
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

  it('bounds hours to what the cron field can express', () => {
    expect(validateInterval(24, 'hours')).toBeNull();
    expect(validateInterval(25, 'hours')).toBeTruthy();
  });

  it('has no interval for daily and weekly', () => {
    expect(validateInterval(1, 'daily')).toBeNull();
    expect(validateInterval(1, 'weekly')).toBeNull();
  });

  it.each([0, -1, 1.5, NaN])('refuses %p', (n) => {
    expect(validateInterval(n as number, 'hours')).toBeTruthy();
  });

  it('accepts everything intervalToCron round-trips, and vice versa', () => {
    for (const unit of ['minutes', 'hours'] as ScheduleUnit[]) {
      for (let i = 1; i <= 60; i++) {
        if (validateInterval(i, unit) === null) {
          expect(cronToInterval(intervalToCron(i, unit))).toMatchObject({ interval: i, unit });
        }
      }
    }
  });
});

describe('cronToHuman', () => {
  it('describes the shapes the editor produces', () => {
    expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronToHuman('0 */6 * * *')).toBe('Every 6 hours');
    expect(cronToHuman(intervalToCron(1, 'daily', DEFAULT_TIME))).toBe('Daily at 08:00');
    expect(cronToHuman(intervalToCron(1, 'weekly', DEFAULT_TIME))).toBe('Weekly on Monday at 08:00');
    expect(cronToHuman('0 0 * * 0')).toBe('Weekly on Sunday at 00:00');
    expect(cronToHuman('0 */1 * * *')).toBe('Every hour');
  });

  it('returns the raw expression rather than guessing at one it cannot model', () => {
    expect(cronToHuman('15 3 1 * 1')).toBe('15 3 1 * 1');
    expect(cronToHuman('15 3 * * 9')).toBe('15 3 * * 9');
    expect(cronToHuman('nonsense')).toBe('nonsense');
  });

  it('never returns an empty string for a valid schedule', () => {
    for (const unit of ['minutes', 'hours', 'daily', 'weekly'] as ScheduleUnit[]) {
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
    for (const unit of ['minutes', 'hours', 'daily', 'weekly'] as ScheduleUnit[]) {
      for (const raw of [0, 1, 3, 7, 30, 55, 100]) {
        expect(validateInterval(snapIntervalToUnit(raw, unit), unit)).toBeNull();
      }
    }
  });
});
