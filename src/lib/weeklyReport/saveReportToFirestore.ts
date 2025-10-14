// -----------------------------------------------------------------------------
// Handles saving AI-generated report results to Firestore.
// Each report is stored under: tg_chats/{chatId}/reports/{autoId}
// -----------------------------------------------------------------------------

import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";

/**
 * Saves an AI-generated report to Firestore under the chat’s reports subcollection.
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
    // Reference: tg_chats/{chatId}/reports/{autoId}
    const ref = db
      .collection("tg_chats")
      .doc(chatId)
      .collection("reports")
      .doc(); // auto-generated ID

    // Write report document
    await ref.set({
      summary: result.summary,
      bullets: result.bullets,
      usage: result.usage,
      finishReason: result.finishReason,
      createdAt: Timestamp.now(),
    });

    console.log(`✅ Report saved to tg_chats/${chatId}/reports/${ref.id}`);
  } catch (err) {
    console.error(`❌ Failed to save report for chat ${chatId}:`, err);
    throw err;
  }
}
