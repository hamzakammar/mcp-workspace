/**
 * Timezone-aware date normalization.
 *
 * Course websites express due dates in the course's local wall-clock time
 * (America/Toronto for SE212/CS241). We convert a parsed wall-clock time in a
 * named IANA zone to a precise UTC instant, correctly accounting for the DST
 * offset in effect on that date. The ORIGINAL source text is always preserved
 * separately by callers — this only computes the canonical instant.
 */

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;  // 0-23
  minute: number;
}

/** Wall-clock parts of a UTC instant, as observed in `timeZone`. */
function partsInZone(instant: Date, timeZone: string): WallClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  let hour = Number(p.hour);
  if (hour === 24) hour = 0; // some environments emit '24' for midnight
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
  };
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC ISO string.
 * Uses the standard offset-solve: guess the instant as if the wall time were UTC,
 * measure how that instant renders in the zone, and correct by the difference.
 */
export function zonedWallTimeToUtcIso(w: WallClock, timeZone: string): string {
  const guessUtcMs = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  const zoned = partsInZone(new Date(guessUtcMs), timeZone);
  const zonedAsUtcMs = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0);
  const offsetMs = zonedAsUtcMs - guessUtcMs; // zone is ahead of UTC by this much at that instant
  return new Date(guessUtcMs - offsetMs).toISOString();
}
