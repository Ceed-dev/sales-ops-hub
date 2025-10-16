import { db } from "../lib/firebase.js";
import type { PersonDoc } from "../types/person.js";

/**
 * Resolve Slack userId (e.g., "U04ABCDE") from a Telegram userId.
 *
 * Selection priority for Slack links:
 *   1) Match by opts.teamId if provided
 *   2) Entry with prefs.enabled === true
 *   3) Fallback to the first entry
 *
 * Returns:
 *   - Slack userId string (e.g., "U0XXXXXX") if resolvable
 *   - null if no matching person or Slack link is found
 *
 * Notes:
 *   - Requires a Firestore index on `people` for the field: `telegram.userId`.
 *   - This function includes a simple in-memory cache to reduce duplicate lookups
 *     within the same process/request.
 */
export async function resolveSlackUserIdByTelegramId(
  tgUserId: string,
  opts?: { teamId?: string },
): Promise<string | null> {
  // --- Fast-fail on empty input ---
  if (!tgUserId) return null;

  // --- In-memory memoization (per process) ---
  const cacheKey = `${tgUserId}::${opts?.teamId ?? ""}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey)!;

  try {
    // Query the "people" collection by Telegram userId (SoT link)
    const snap = await db
      .collection("people")
      .where("telegram.userId", "==", String(tgUserId))
      .limit(1)
      .get();

    if (snap.empty) {
      CACHE.set(cacheKey, null);
      return null;
    }

    const doc = snap.docs[0];
    if (!doc) {
      CACHE.set(cacheKey, null);
      return null;
    }

    const person = doc.data() as PersonDoc;
    const links = person.slack ?? [];
    if (!links.length) {
      CACHE.set(cacheKey, null);
      return null;
    }

    // 1) Prefer workspace (teamId) if specified
    if (opts?.teamId) {
      const matched = links.find((l) => l.teamId === opts.teamId && !!l.userId);
      if (matched?.userId) {
        CACHE.set(cacheKey, matched.userId);
        return matched.userId;
      }
    }

    // 2) Prefer enabled link if exists
    const enabled = links.find((l) => l.prefs?.enabled && !!l.userId);
    if (enabled?.userId) {
      CACHE.set(cacheKey, enabled.userId);
      return enabled.userId;
    }

    // 3) Fallback to the first link
    const first = links[0]?.userId ?? null;
    CACHE.set(cacheKey, first ?? null);
    return first ?? null;
  } catch (err) {
    // Non-fatal: log and return null so caller can gracefully fallback to a label
    console.warn("[resolveSlackUserIdByTelegramId] Firestore error:", err);
    CACHE.set(cacheKey, null);
    return null;
  }
}

/** Simple in-memory cache keyed by "<tgUserId>::<teamId?>". */
const CACHE = new Map<string, string | null>();
