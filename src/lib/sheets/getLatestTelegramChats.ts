// -----------------------------------------------------------------------------
// Fetch the latest Telegram group chat (GC) data from Firestore.
// - Reads all documents from the "tg_chats" collection
// - Supports pagination to safely fetch large datasets
// - Returns an array of { id, title } objects
// -----------------------------------------------------------------------------

import { db } from "../firebase.js";

/** Represents a single Telegram group chat row */
export type ChatRow = {
  id: string;
  title: string;
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
 * Fetches all Telegram group chats from Firestore (`tg_chats` collection)
 * and returns the latest list of chat metadata.
 *
 * @param opts - Optional filters and sorting configuration
 * @returns Promise resolving to an array of chat rows [{ id, title }]
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
      const d = doc.data() ?? {};
      rows.push({
        id: doc.id,
        title: (d.title as string) ?? "",
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
