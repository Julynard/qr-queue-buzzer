// Time-zone math for the daily reset. Workers run in UTC, so "midnight in Manila" has to be
// converted to a UTC timestamp using the shop's IANA time zone.

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `ms` in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as unknown as ZonedParts;
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds (Manila = +8h). */
function offsetAt(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/** UTC timestamp of a wall-clock time in `timeZone`. Day/month overflow is allowed (day 32 = next month). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone); // corrects for a DST change between guess and result
  return second;
}

/** The first moment strictly after `now` when the wall clock in `timeZone` reads `hhmm` ("HH:MM"). */
export function nextResetAfter(now: number, hhmm: string, timeZone: string): number {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  const today = zonedParts(now, timeZone);
  let t = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (t <= now) t = zonedTimeToUtc(today.year, today.month, today.day + 1, hour, minute, timeZone);
  return t;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export const isValidResetTime = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
