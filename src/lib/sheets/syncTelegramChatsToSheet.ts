// -----------------------------------------------------------------------------
// Orchestrates the end-to-end sync:
// 1) Fetch latest chats from Firestore
// 2) Overwrite the "Chat" tab in Google Sheets (header preserved)
// 3) Overwrite the "Meta" tab with sync metrics
// - Notify Slack ONLY on errors
// -----------------------------------------------------------------------------

import { getLatestTelegramChats } from "./getLatestTelegramChats.js";
import { overwriteChatTab } from "./overwriteChatTab.js";
import { overwriteMetaTab } from "./overwriteMetaTab.js";
import { sendSlackAlert } from "./sendSlackAlert.js";

const CHAT_TAB = "Chat";
const META_TAB = "Meta";

export async function syncTelegramChatsToSheet() {
  const spreadsheetId = process.env.CHATS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    const msg =
      "[syncTelegramChatsToSheet] Missing env CHATS_SPREADSHEET_ID. Set it in .env or Cloud Run env.";
    await sendSlackAlert(msg);
    throw new Error(msg);
  }

  const startHr = process.hrtime.bigint();
  console.log("[syncTelegramChatsToSheet] Firestore → Sheets sync started");

  try {
    // 1) Fetch all chats from Firestore
    const chats = await getLatestTelegramChats({
      filterActiveOnly: true, // Change if needed
      orderBy: "id",
    });
    console.log(
      `[syncTelegramChatsToSheet] fetched ${chats.length} chats from Firestore`,
    );

    // 2) Overwrite Chat tab
    await overwriteChatTab(spreadsheetId, chats, CHAT_TAB);
    console.log("[syncTelegramChatsToSheet] Chat tab overwritten successfully");

    // 3) Update Meta tab
    const durationMs = Number((process.hrtime.bigint() - startHr) / 1_000_000n);
    const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", " +09:00");
    await overwriteMetaTab(
      spreadsheetId,
      {
        lastSyncAt: nowJst,
        syncedCount: chats.length,
        syncDurationMs: durationMs,
      },
      META_TAB,
    );

    const summary = {
      count: chats.length,
      durationMs,
      chatTab: CHAT_TAB,
      metaTab: META_TAB,
    };
    console.log("[syncTelegramChatsToSheet] done", summary);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : JSON.stringify(err, null, 2);
    await sendSlackAlert(`*SyncTelegramChatsToSheet failed*\n> ${message}`);
    console.error("[syncTelegramChatsToSheet] failed:", err);
    throw err;
  }
}
