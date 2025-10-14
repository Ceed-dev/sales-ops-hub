// -----------------------------------------------------------------------------
// Update operational metadata on a report setting document.
// Path: reports_settings/{settingId}
// - Success: updates lastRunAt, lastSuccessAt, updatedAt and clears lastError
// - Error:   updates lastRunAt, lastError{message, at}, updatedAt
// -----------------------------------------------------------------------------

import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";

/**
 * Update execution status for a report setting.
 *
 * @param settingId - Firestore doc ID in `reports_settings` (e.g., "chat-12345:weekly")
 * @param status    - "success" or "error"
 * @param error     - Optional error object to record when status === "error"
 */
export async function updateReportStatus(
  settingId: string,
  status: "success" | "error",
  error?: unknown,
): Promise<void> {
  try {
    const now = Timestamp.now();
    const ref = db.collection("reports_settings").doc(settingId);

    // Always record last run + updatedAt
    const updateData: Record<string, any> = {
      lastRunAt: now,
      updatedAt: now,
    };

    if (status === "success") {
      updateData.lastSuccessAt = now;
      updateData.lastError = null; // clear previous error if any
    } else {
      updateData.lastError = {
        message: toErrorMessage(error),
        at: now,
      };
    }

    await ref.update(updateData);
    console.log(`✅ Updated report status (${status}) for ${settingId}`);
  } catch (e) {
    // Non-fatal: log and continue (do not throw to avoid masking prior errors)
    console.error(`❌ Failed to update report status for ${settingId}:`, e);
  }
}

/** Convert unknown error into a concise, serializable message string. */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
