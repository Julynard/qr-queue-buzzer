// Time-zone math for the daily reset. Workers run in UTC, so "midnight in Manila" has to be
// converted to a UTC timestamp using the shop's IANA time zone.

const partsCache = new Map();

function formatter(timeZone) {
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
export function zonedParts(ms, timeZone) {
  const out = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out; // { year, month (1-12), day, hour, minute, second }
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds (Manila = +8h). */
function offsetAt(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/** UTC timestamp of a wall-clock time in `timeZone`. Day/month overflow is allowed (day 32 = next month). */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone); // corrects for a DST change between guess and result
  return second;
}

/** The first moment strictly after `now` when the wall clock in `timeZone` reads `hhmm` ("HH:MM"). */
export function nextResetAfter(now, hhmm, timeZone) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const today = zonedParts(now, timeZone);
  let t = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (t <= now) t = zonedTimeToUtc(today.year, today.month, today.day + 1, hour, minute, timeZone);
  return t;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export const isValidResetTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
