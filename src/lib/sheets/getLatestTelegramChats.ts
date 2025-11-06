// -----------------------------------------------------------------------------
// Fetch the latest Telegram group chat (GC) data from Firestore.
// - Reads all documents from the "tg_chats" collection
// - Supports pagination to safely fetch large datasets
// - Returns an array of { id, title, latestMsgFrom, latestMsgAt, latestMsgSummary }
// -----------------------------------------------------------------------------

import { db } from "../firebase.js";

/** Represents a single Telegram group chat row */
export type ChatRow = {
  id: string;
  title: string;
  latestMsgFrom: string;
  latestMsgAt: string;
  latestMsgSummary: string;
};

/** Optional parameters to control query behavior */
export type ListChatsOptions = {
  /** Whether to fetch only chats with status == "active" */
  filterActiveOnly?: boolean;
  /** Field to sort by ("id" is sorted in-memory after fetch) */
  orderBy?: "id" | "title" | "lastActiveAt";
  /** Maximum number of documents to fetch per query (for pagination) */
  pageSize?: number;
};

/**
 * Convert various timestamp inputs (Firestore Timestamp | Date | ISO string | epoch ms)
 * into a Japan Standard Time string formatted as "YYYY/MM/DD HH:mm JST".
 *
 * - Accepts:
 *   - Firestore Timestamp-like object (has `toDate(): Date`)
 *   - native `Date`
 *   - ISO 8601 string (e.g., "2025-11-06T07:23:00.000Z")
 *   - epoch milliseconds (number)
 * - Returns:
 *   - Formatted string in JST: "YYYY/MM/DD HH:mm JST"
 *   - `null` if input is falsy or cannot be parsed into a valid Date
 */
// --- Example ---
// const s = toJstString(Timestamp.now());         // "2025/11/06 16:23 JST"
// const s2 = toJstString("2025-11-06T07:23:00Z"); // "2025/11/06 16:23 JST"
// const s3 = toJstString(Date.now());             // "2025/11/06 16:23 JST"

export function toJstString(ts?: unknown): string | null {
  if (ts == null) return null;

  // Normalize input → native Date
  let date: Date;

  // Narrow type guard for Firestore Timestamp-like objects
  const maybeTs = ts as { toDate?: () => Date };

  if (typeof maybeTs?.toDate === "function") {
    // Firestore Timestamp (or compatible) → convert to Date (UTC-based)
    date = maybeTs.toDate();
  } else if (ts instanceof Date) {
    date = ts;
  } else if (typeof ts === "string" || typeof ts === "number") {
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) return null; // invalid date string/number
    date = parsed;
  } else {
    // Fallback attempt: try constructing a Date from unknown input
    try {
      // @ts-ignore — last-resort coercion
      const guess = new Date(ts as any);
      if (Number.isNaN(guess.getTime())) return null;
      date = guess;
    } catch {
      return null;
    }
  }

  // Format in Asia/Tokyo (JST, UTC+9) without seconds, 24-hour clock.
  // Output example: "2025/11/06 16:23 JST"
  const jst = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

  return `${jst} JST`;
}

/**
 * Fetches all Telegram group chats from Firestore (`tg_chats` collection)
 * and returns the latest list of chat metadata.
 *
 * @param opts - Optional filters and sorting configuration
 * @returns Promise resolving to an array of chat rows
 */
export async function getLatestTelegramChats(
  opts: ListChatsOptions = {},
): Promise<ChatRow[]> {
  const { filterActiveOnly = false, orderBy = "id", pageSize = 1000 } = opts;

  // --- 1. Build Firestore query base ----------------------------------------
  const col = db.collection("tg_chats");
  let q: FirebaseFirestore.Query = col;

  if (filterActiveOnly) {
    q = q.where("status", "==", "active");
  }

  if (orderBy === "title") {
    q = q.orderBy("title");
  } else if (orderBy === "lastActiveAt") {
    q = q.orderBy("lastActiveAt", "desc");
  }
  // (orderBy === "id") will be handled in-memory after fetching all docs

  // --- 2. Fetch documents with pagination -----------------------------------
  const rows: ChatRow[] = [];
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  while (true) {
    // Fetch one page (limited batch of documents)
    let pageQuery = q.limit(pageSize);
    if (lastDoc) {
      // Continue from the last document of the previous batch
      pageQuery = pageQuery.startAfter(lastDoc);
    }

    const snap = await pageQuery.get();
    if (snap.empty) break; // no more documents

    // Extract and map each document to ChatRow
    for (const doc of snap.docs) {
      const d: any = doc.data() ?? {};
      const lm = d.latestMessage ?? {};

      rows.push({
        id: doc.id,
        title: (d.title as string) ?? "",
        latestMsgFrom: lm.fromUsername ?? "",
        latestMsgAt: toJstString(lm.sentAt) ?? "",
        latestMsgSummary: lm.summary ?? "",
      });
    }

    // Update cursor for next loop
    lastDoc = snap.docs[snap.docs.length - 1];

    // Stop if this page was not full (meaning we've reached the end)
    if (snap.size < pageSize) break;
  }

  // --- 3. In-memory sort when orderBy = "id" --------------------------------
  if (orderBy === "id") {
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // --- 4. Return the aggregated results -------------------------------------
  return rows;
}
