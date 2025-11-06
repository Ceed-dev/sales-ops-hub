// -----------------------------------------------------------------------------
// Overwrite a single "Meta" tab in a Google Spreadsheet.
// - Does NOT clear the sheet; simply overwrites A1:B3 (values only)
// - Keeps formatting intact
// - Expects exactly three rows: lastSyncAt, syncedCount, syncDurationMs
// -----------------------------------------------------------------------------

import { getSheetsClient } from "./client.js";

/** Payload to write into the Meta tab */
export type MetaPayload = {
  /** ISO timestamp string (e.g., 2025-11-06T11:45:00+09:00) */
  lastSyncAt: string;
  /** Number of rows written to the Chat tab */
  syncedCount: number;
  /** Elapsed time in milliseconds for the sync */
  syncDurationMs: number;
};

/**
 * Overwrites the Meta tab (A1:B3) with the given payload.
 *
 * Behavior:
 *  - Writes:
 *      A1:B1 -> ["lastSyncAt",   meta.lastSyncAt]
 *      A2:B2 -> ["syncedCount",  String(meta.syncedCount)]
 *      A3:B3 -> ["syncDurationMs", String(meta.syncDurationMs)]
 *  - Uses valueInputOption = "RAW" (no formula parsing)
 *
 * @param spreadsheetId Google Spreadsheet (file) ID
 * @param meta          Sync meta information
 * @param tabName       Target tab (sheet) name. Defaults to "Meta"
 */
export async function overwriteMetaTab(
  spreadsheetId: string,
  meta: MetaPayload,
  tabName = "Meta",
): Promise<void> {
  const sheets = getSheetsClient();

  const values: (string | number)[][] = [
    ["lastSyncAt", meta.lastSyncAt],
    ["syncedCount", String(meta.syncedCount)],
    ["syncDurationMs", String(meta.syncDurationMs)],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1:B3`,
    valueInputOption: "RAW",
    requestBody: { values },
  });

  console.log(`[overwriteMetaTab] Updated ${tabName} (A1:B3).`);
}
