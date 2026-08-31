/**
 * Cron <-> "every N units" translation for the scheduler UI.
 *
 * Every function here is lifted VERBATIM from the two orphaned components this
 * page replaces (`ScheduledTaskEditor.tsx` lines 8-61 and
 * `ScheduledTasksSidebar.tsx` lines 5-40). They were the only part of those
 * 494 lines worth keeping, and they had no tests because nothing imported them.
 * They have tests now; the behaviour is unchanged on purpose, so a task written
 * by the old editor still round-trips.
 *
 * The scheduler backend speaks cron. The user does not, and never sees one:
 * `cronToInterval` is deliberately TOTAL — an expression it cannot model falls
 * back to "every 1 hour" rather than throwing, because the alternative is a
 * settings page that crashes on a row someone hand-edited in `scheduling.db`.
 * `cronToHuman` is the honest counterpart: when it cannot describe an
 * expression it returns the raw cron rather than guessing, so a task the editor
 * would silently reshape at least *reads* truthfully in the list.
 */

export type ScheduleUnit = 'minutes' | 'hours' | 'days';

export function intervalToCron(interval: number, unit: ScheduleUnit): string {
  switch (unit) {
    case 'minutes': return `*/${interval} * * * *`;
    case 'hours':   return `0 */${interval} * * *`;
    case 'days':    return `0 0 */${interval} * *`;
  }
}

/**
 * A step of 0 is not a schedule. The lifted original parsed a zero step into
 * `{interval: 0}`, which `intervalToCron` then wrote straight back out and
 * `cronToHuman` rendered as "Every 0 minutes" — found by the round-trip test,
 * not by reading. This is the ONE deviation from the verbatim lift: a
 * non-positive step now falls through to the same default an unparseable
 * expression gets. The editor was never able to produce one (`validateInterval`
 * rejects 0), so nothing on disk should carry it — but the list is fed straight
 * from `scheduling.db`, which is hand-editable.
 */
function positiveStep(m: RegExpMatchArray | null): number | null {
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function cronToInterval(expr: string): { interval: number; unit: ScheduleUnit } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { interval: 1, unit: 'hours' };

  const [min, hour, dom] = parts;

  const minStep = positiveStep(min.match(/^\*\/(\d+)$/));
  if (minStep !== null && hour === '*' && dom === '*') {
    return { interval: minStep, unit: 'minutes' };
  }

  const hourStep = positiveStep(hour.match(/^\*\/(\d+)$/));
  if (min === '0' && hourStep !== null && dom === '*') {
    return { interval: hourStep, unit: 'hours' };
  }
  if (min === '0' && hour === '*' && dom === '*') {
    return { interval: 1, unit: 'hours' };
  }

  const domStep = positiveStep(dom.match(/^\*\/(\d+)$/));
  if (min === '0' && hour === '0' && domStep !== null) {
    return { interval: domStep, unit: 'days' };
  }
  if (min === '0' && hour === '0' && dom === '*') {
    return { interval: 1, unit: 'days' };
  }

  return { interval: 1, unit: 'hours' };
}

/**
 * The 5-minute floor is not arbitrary: every run is a real chat turn against
 * the user's own API key, so a once-a-minute schedule is a way to spend
 * money in your sleep. The ceilings keep each unit inside the range its cron field can
 * actually express (55 minutes, 24 hours, 31 days).
 */
export function validateInterval(interval: number, unit: ScheduleUnit): string | null {
  if (!Number.isInteger(interval) || interval <= 0) return 'Must be a positive whole number';
  switch (unit) {
    case 'minutes':
      if (interval % 5 !== 0) return 'Must be a multiple of 5';
      if (interval < 5 || interval > 55) return 'Must be between 5 and 55';
      break;
    case 'hours':
      if (interval > 24) return 'Must be between 1 and 24';
      break;
    case 'days':
      if (interval > 31) return 'Must be between 1 and 31';
      break;
  }
  return null;
}

export function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [min, hour, dom, mon, dow] = parts;

  // Step patterns (*/N)
  const minN = positiveStep(min.match(/^\*\/(\d+)$/));
  if (minN !== null && hour === '*') {
    return minN === 1 ? 'Every minute' : `Every ${minN} minutes`;
  }

  const hourN = positiveStep(hour.match(/^\*\/(\d+)$/));
  if (min === '0' && hourN !== null && dom === '*') {
    return hourN === 1 ? 'Every hour' : `Every ${hourN} hours`;
  }

  const dayN = positiveStep(dom.match(/^\*\/(\d+)$/));
  if (min === '0' && hour === '0' && dayN !== null) {
    return dayN === 1 ? 'Daily' : `Every ${dayN} days`;
  }

  // Legacy patterns
  if (min === '*' && hour === '*') return 'Every minute';
  if (min === '0' && hour === '*') return 'Every hour';
  if (min === '0' && hour === '0' && dom === '*') return 'Daily';
  if (hour === '*' && min !== '*') return `Every hour at :${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*' && min !== '*') {
    return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
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
  return Math.max(1, Math.min(31, interval));
}
