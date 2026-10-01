/**
 * Cron <-> schedule translation for the scheduler UI.
 *
 * The scheduler backend speaks cron. The user does not, and never sees one:
 * `cronToInterval` is deliberately TOTAL — an expression it cannot model falls
 * back to "every 1 hour" rather than throwing, because the alternative is a
 * settings page that crashes on a row someone hand-edited in `scheduling.db`.
 * `cronToHuman` is the honest counterpart: when it cannot describe an
 * expression it returns the raw cron rather than guessing, so a task the editor
 * would silently reshape at least *reads* truthfully in the list.
 */

export type ScheduleUnit = 'minutes' | 'hours' | 'daily' | 'weekly';

/** Local wall-clock time, plus a weekday (0 = Sunday) that only `weekly` reads. */
export interface TimeOfDay { hour: number; minute: number; weekday: number }

export const DEFAULT_TIME: TimeOfDay = { hour: 8, minute: 0, weekday: 1 };

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * There is deliberately NO way to emit a step in the day-of-month field. That
 * was the old "every N days": a step over the days of the MONTH, so "every 25"
 * fires on the 1st and 26th, and on Oct 29 the next run is Nov 1, not Nov 23.
 * Daily and weekly are the two cadences a person actually means, and each is
 * expressible exactly (`M H * * *`, `M H * * D`). Times are local, which is
 * what the scheduler's cron parser uses.
 */
export function intervalToCron(interval: number, unit: ScheduleUnit, at: TimeOfDay = DEFAULT_TIME): string {
  switch (unit) {
    case 'minutes': return `*/${interval} * * * *`;
    case 'hours':   return `0 */${interval} * * *`;
    case 'daily':   return `${at.minute} ${at.hour} * * *`;
    case 'weekly':  return `${at.minute} ${at.hour} * * ${at.weekday}`;
  }
}

/** "08:00", the value format of an <input type="time">. */
export function formatTime(at: Pick<TimeOfDay, 'hour' | 'minute'>): string {
  return `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
}

/** The inverse of `formatTime`; null for anything an <input type="time"> would not produce. */
export function parseTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/**
 * A step of 0 is not a schedule. A non-positive step falls through to the same
 * default an unparseable expression gets. The editor was never able to produce
 * one (`validateInterval` rejects 0), so nothing on disk should carry it — but
 * the list is fed straight from `scheduling.db`, which is hand-editable.
 */
function positiveStep(m: RegExpMatchArray | null): number | null {
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A plain one- or two-digit number no larger than `max`, else null. */
function num(field: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = parseInt(field, 10);
  return n <= max ? n : null;
}

/**
 * A task written when the editor still had a "days" unit: midnight on a
 * day-of-month step above 1. It does not mean "every N days" (it restarts on
 * the 1st of each month), so the editor opens it as the default schedule and
 * says it will be replaced on save instead of pretending to model it.
 */
export function isLegacyDayOfMonthStep(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  const n = positiveStep(dom.match(/^\*\/(\d+)$/));
  return min === '0' && hour === '0' && n !== null && n > 1 && mon === '*' && dow === '*';
}

export function cronToInterval(expr: string): { interval: number; unit: ScheduleUnit } & TimeOfDay {
  const fallback = { interval: 1, unit: 'hours' as ScheduleUnit, ...DEFAULT_TIME };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;

  const [min, hour, dom, mon, dow] = parts;

  const minStep = positiveStep(min.match(/^\*\/(\d+)$/));
  if (minStep !== null && hour === '*' && dom === '*') {
    return { ...fallback, interval: minStep, unit: 'minutes' };
  }

  const hourStep = positiveStep(hour.match(/^\*\/(\d+)$/));
  if (min === '0' && hourStep !== null && dom === '*') {
    return { ...fallback, interval: hourStep, unit: 'hours' };
  }
  if (min === '0' && hour === '*' && dom === '*') {
    return fallback;
  }

  // The old editor's "every 1 day" was `0 0 */1 * *`, which is simply daily at
  // midnight. A step above 1 is NOT modelled (see isLegacyDayOfMonthStep).
  const domOne = positiveStep(dom.match(/^\*\/(\d+)$/)) === 1;
  if ((dom === '*' || domOne) && mon === '*') {
    const m = num(min, 59);
    const h = num(hour, 23);
    if (m !== null && h !== null) {
      if (dow === '*') return { ...fallback, unit: 'daily', hour: h, minute: m };
      const d = num(dow, 7);
      if (d !== null && dom === '*') {
        return { ...fallback, unit: 'weekly', hour: h, minute: m, weekday: d % 7 };
      }
    }
  }

  return fallback;
}

/**
 * The 5-minute floor is not arbitrary: every run is a real chat turn against
 * the user's own API key, so a once-a-minute schedule is a way to spend
 * money in your sleep. The ceilings keep each unit inside the range its cron
 * field can actually express (55 minutes, 24 hours). Daily and weekly have no
 * interval at all, only a time, which an <input type="time"> keeps valid.
 */
export function validateInterval(interval: number, unit: ScheduleUnit): string | null {
  if (unit === 'daily' || unit === 'weekly') return null;
  if (!Number.isInteger(interval) || interval <= 0) return 'Must be a positive whole number';
  switch (unit) {
    case 'minutes':
      if (interval % 5 !== 0) return 'Must be a multiple of 5';
      if (interval < 5 || interval > 55) return 'Must be between 5 and 55';
      break;
    case 'hours':
      if (interval > 24) return 'Must be between 1 and 24';
      break;
  }
  return null;
}

export function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [min, hour, dom, mon, dow] = parts;

  // Step patterns (star-slash N)
  const minN = positiveStep(min.match(/^\*\/(\d+)$/));
  if (minN !== null && hour === '*') {
    return minN === 1 ? 'Every minute' : `Every ${minN} minutes`;
  }

  const hourN = positiveStep(hour.match(/^\*\/(\d+)$/));
  if (min === '0' && hourN !== null && dom === '*') {
    return hourN === 1 ? 'Every hour' : `Every ${hourN} hours`;
  }

  // Tasks written before daily/weekly existed. Say what the cron really does:
  // a step over the day of the MONTH, restarting on the 1st.
  const dayN = positiveStep(dom.match(/^\*\/(\d+)$/));
  if (min === '0' && hour === '0' && dayN !== null) {
    return dayN === 1 ? 'Daily at 00:00' : `Every ${dayN} days of the month (from the 1st)`;
  }

  // Legacy patterns
  if (min === '*' && hour === '*') return 'Every minute';
  if (min === '0' && hour === '*') return 'Every hour';
  if (hour === '*' && min !== '*') return `Every hour at :${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*' && min !== '*') {
    return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && hour !== '*' && min !== '*') {
    const d = num(dow, 7);
    if (d !== null && num(hour, 23) !== null && num(min, 59) !== null) {
      return `Weekly on ${WEEKDAYS[d % 7]} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
  }

  return expr;
}

/**
 * Snap an interval into the range a newly-chosen unit allows, so switching
 * "30 minutes" to "hours" yields a valid 24 rather than an invalid 30.
 */
export function snapIntervalToUnit(interval: number, unit: ScheduleUnit): number {
  if (unit === 'minutes') return Math.max(5, Math.min(55, Math.round(interval / 5) * 5));
  if (unit === 'hours') return Math.max(1, Math.min(24, interval));
  return 1;
}
