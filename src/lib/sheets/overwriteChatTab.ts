// -----------------------------------------------------------------------------
// Overwrite a single tab ("Chat" by default) in a Google Spreadsheet.
// - Keeps the header row (row 1) intact
// - Clears all data rows (row 2 and below)
// - Writes the provided chat rows in one batch
// -----------------------------------------------------------------------------

import { getSheetsClient } from "./client.js";
import type { ChatRow } from "./getLatestTelegramChats.js";

/**
 * Overwrites the specified tab with the given chat data.
 *
 * Behavior:
 *  - Clears values in A2:Z (header preserved)
 *  - Writes rows starting at A2 as [id, title, ...]
 *
 * @param spreadsheetId Google Spreadsheet (file) ID
 * @param chats         Array of chat rows to write (e.g., [{ id, title, ... }, ...])
 * @param tabName       Target tab (sheet) name. Defaults to "Chat"
 */
export async function overwriteChatTab(
  spreadsheetId: string,
  chats: ChatRow[],
  tabName = "Chat",
): Promise<void> {
  // --- 1) Acquire Sheets API client -----------------------------------------
  const sheets = getSheetsClient();

  // --- 2) Clear all rows below the header (values only; formatting remains) --
  // Use a wide clear range so future column additions remain safe.
  const CLEAR_RANGE = `${tabName}!A2:Z`;
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: CLEAR_RANGE,
  });

  // --- 3) If there's nothing to write, stop after clearing -------------------
  if (chats.length === 0) {
    console.log(
      `[overwriteChatTab] No rows to write; cleared "${tabName}" only.`,
    );
    return;
  }

  // --- 4) Map ChatRow[] -> 2D values array and write from A2 -----------------
  // NOTE: Extend this mapping when you add more columns (e.g., memberCount, updatedAt).
  const values = chats.map(
    ({
      id,
      title,
      latestMsgFrom,
      latestMsgAt,
      latestMsgSummary,
      botAddedAt,
    }) => [id, title, latestMsgFrom, latestMsgAt, latestMsgSummary, botAddedAt],
  );

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A2`,
    valueInputOption: "RAW", // write raw values; no formula parsing
    requestBody: { values },
  });

  console.log(`[overwriteChatTab] Wrote ${chats.length} rows to "${tabName}".`);
}
