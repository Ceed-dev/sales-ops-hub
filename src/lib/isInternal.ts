/**
 * Internal member detector (hard-coded)
 *
 * - Put Telegram user IDs of team members in the set below.
 * - Comparison is string-based; any input is coerced to string & trimmed.
 * - Minimal surface: call `isFromInternal(message.sender.id)`.
 */

/** Team member IDs */
const INTERNAL_USER_IDS = new Set<string>([
  "5106417385", // ellie_hype
  "5302025575", // yusaku_zach
  "6217645240", // itsBadhan
  "7888860699", // Srijanweb3
  "6288713798", // pochi_udon
  "1878347283", // Draken0004
  "951221958", // jazcomoda
  "5559185358", // Hugo_kayo
  "6292079093", // ronaparajit
]);

/** Returns true when the senderId belongs to an internal member. */
export function isFromInternal(senderId: unknown): boolean {
  if (senderId == null) return false;
  const key = String(senderId).trim();
  return INTERNAL_USER_IDS.has(key);
}
