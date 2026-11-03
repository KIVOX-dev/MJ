/** Offset (ms) of `tz` from UTC at the given instant: local = utc + offset. DST-aware via Intl. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to the real instant (handles daylight-saving changes). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass fixes times near a DST boundary
  return new Date(t);
}

/** Calendar date (y, m, d) in `tz` for an instant. */
export function localDate(at: Date, tz: string): { y: number; m: number; d: number } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at)
    .split('-')
    .map(Number);
  return { y: y!, m: m!, d: d! };
}

/**
 * Resolves "today" | "tomorrow" | "YYYY-MM-DD" plus "HH:mm" (24h) to an instant in `tz`.
 * Date arithmetic is done here, never by the language model.
 */
export function resolveLocalDateTime(day: string, time: string, now: Date, tz: string): Date {
  const tm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!tm) throw new Error('time must be HH:mm in 24-hour format');
  const key = day.trim().toLowerCase();
  let { y, m, d } = localDate(now, tz);
  if (key === 'tomorrow') {
    const n = new Date(Date.UTC(y, m - 1, d + 1));
    ({ y, m, d } = { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() });
  } else if (key !== 'today') {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!dm) throw new Error('day must be "today", "tomorrow" or YYYY-MM-DD');
    y = Number(dm[1]);
    m = Number(dm[2]);
    d = Number(dm[3]);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new Error('That calendar date does not exist');
  }
  return zonedToUtc(y, m, d, Number(tm[1]), Number(tm[2]), tz);
}
