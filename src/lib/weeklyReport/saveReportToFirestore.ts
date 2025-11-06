// -----------------------------------------------------------------------------
// Handles saving AI-generated report results to Firestore.
// Each report is stored under: tg_chats/{chatId}/reports/{autoId}
// -----------------------------------------------------------------------------

import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";

/**
 * Saves an AI-generated report to Firestore under the chat’s reports subcollection,
 * and updates tg_chats/{chatId}.latestReportId to the new report’s ID.
 *
 * @param chatId - Telegram chat ID (string)
 * @param result - The object returned from summarizeWithAI(), containing summary data
 */
export async function saveReportToFirestore(
  chatId: string,
  result: {
    summary: string;
    bullets: any[];
    usage: Record<string, any>;
    finishReason: string;
  },
): Promise<void> {
  try {
    const chatRef = db.collection("tg_chats").doc(chatId);
    const reportRef = chatRef.collection("reports").doc(); // auto ID

    await db.runTransaction(async (tx) => {
      // --- 1. create report doc ---
      tx.set(reportRef, {
        summary: result.summary,
        bullets: result.bullets,
        usage: result.usage,
        finishReason: result.finishReason,
        createdAt: Timestamp.now(),
      });

      // --- 2. update parent latestReportId ---
      tx.update(chatRef, { latestReportId: reportRef.id });
    });

    console.log(
      `✅ Report saved & latestReportId updated: ${chatId} → ${reportRef.id}`,
    );
  } catch (err) {
    console.error(`❌ Failed to save report for chat ${chatId}:`, err);
    throw err;
  }
}
