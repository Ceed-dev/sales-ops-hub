import { Timestamp } from "firebase-admin/firestore";

// -----------------------------------------------------------------------------
// Returns a Firestore Timestamp representing "15:00 JST on the 3rd day after"
// the given UTC date.
// - Input: sentAt (UTC Date)
// - Output: UTC Timestamp equivalent to target JST time
// -----------------------------------------------------------------------------

const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // +09:00
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const FIFTEEN_HOURS_MS = 15 * 60 * 60 * 1000;

export function jst1500On3rdDay(sentAt: Date): Timestamp {
  // Convert UTC → JST
  const jstMillis = sentAt.getTime() + JST_OFFSET_MS;
  const jstDate = new Date(jstMillis);

  // Get midnight (00:00 JST) of that day
  const jstMidnight = new Date(
    Date.UTC(
      jstDate.getUTCFullYear(),
      jstDate.getUTCMonth(),
      jstDate.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );

  // Add 3 days
  const targetDayJSTMidnight = new Date(jstMidnight.getTime() + THREE_DAYS_MS);

  // Add 15:00 JST
  const targetDayJST1500 = new Date(
    targetDayJSTMidnight.getTime() + FIFTEEN_HOURS_MS,
  );

  // Convert back to UTC
  const utcMillis = targetDayJST1500.getTime() - JST_OFFSET_MS;
  return Timestamp.fromDate(new Date(utcMillis));
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
