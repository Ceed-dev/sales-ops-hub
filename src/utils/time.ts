// -----------------------------------------------------------------------------
// Returns a Firestore Timestamp scheduled in JST with flexible options.
// -----------------------------------------------------------------------------

import { Timestamp } from "firebase-admin/firestore";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type ScheduleOpts = {
  /** Number of days to add (calendar/business). Default: 3 */
  days?: number;
  /** Hour in JST. Default: 15 */
  hour?: number;
  /** Minute in JST. Default: 0 */
  minute?: number;
  /** Count only business days (skip Sat/Sun). Default: true */
  businessDays?: boolean;
};

/** Add N days (calendar or business) to a JST calendar date. */
function addDaysJST(
  baseUTCDateAt00Z: Date,
  days: number,
  businessDays: boolean,
): Date {
  if (!businessDays)
    return new Date(baseUTCDateAt00Z.getTime() + days * ONE_DAY_MS);

  let d = 0;
  let cur = new Date(baseUTCDateAt00Z); // represents JST calendar date (Y/M/D) at 00:00Z placeholder
  while (d < days) {
    cur = new Date(cur.getTime() + ONE_DAY_MS);
    const dow = cur.getUTCDay(); // 0=Sun, 6=Sat (calendar-day is timezone-agnostic)
    if (dow !== 0 && dow !== 6) d++;
  }
  return cur;
}

/**
 * Schedule time in JST with options.
 * Keeps current behavior by default: 3 business days later at 15:00 JST.
 *
 * @param sentAt  Original event time (Date in UTC)
 * @param opts    Optional overrides (days/hour/minute/businessDays)
 * @returns       Firestore Timestamp at the computed UTC instant
 */
export function scheduleAtJST(
  sentAt: Date,
  opts: ScheduleOpts = {},
): Timestamp {
  const days = opts.days ?? 3;
  const hour = opts.hour ?? 15;
  const minute = opts.minute ?? 0;
  const businessDays = opts.businessDays ?? true;

  // Convert to JST calendar components by shifting the clock
  const jst = new Date(sentAt.getTime() + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const d = jst.getUTCDate();

  // Base JST "midnight" as a calendar anchor (stored as UTC 00:00Z of that JST date)
  const baseJSTCalendarAt00Z = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));

  // Advance days (calendar/business) on JST calendar
  const targetJSTCalendarAt00Z = addDaysJST(
    baseJSTCalendarAt00Z,
    days,
    businessDays,
  );

  // Build the target JST wall-clock time, then convert back to UTC
  const ty = targetJSTCalendarAt00Z.getUTCFullYear();
  const tm = targetJSTCalendarAt00Z.getUTCMonth();
  const td = targetJSTCalendarAt00Z.getUTCDate();

  // This is "hour:minute JST" for that JST date → convert to UTC by subtracting the offset
  const targetUtcMillis =
    Date.UTC(ty, tm, td, hour, minute, 0, 0) - JST_OFFSET_MS;

  return Timestamp.fromMillis(targetUtcMillis);
}

// -----------------------------------------------------------------------------
// Returns a date key string ("YYYY-MM-DD") in UTC from a given ms timestamp.
// -----------------------------------------------------------------------------
export function toUtcDayKey(msUtc: number): string {
  const d = new Date(msUtc);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format a date as "YYYY/MM/DD HH:mm:ss JST" in Asia/Tokyo
// Accepts Date | number(ms) | Firestore Timestamp
// ─────────────────────────────────────────────────────────────────────────────
export function formatJST(input: Date | number | Timestamp): string {
  const date =
    input instanceof Timestamp
      ? input.toDate()
      : typeof input === "number"
        ? new Date(input)
        : input;

  const s = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

  return `${s} JST`; // Example: "2025/10/11 10:18:15 JST"
}
