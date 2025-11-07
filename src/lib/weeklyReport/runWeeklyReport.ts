// -----------------------------------------------------------------------------
// Orchestrates the weekly report pipeline per active report setting:
// 1) Load active settings
// 2) For each target:
//    - Build AI input payload (fetch messages internally)
//    - Call Vertex AI to summarize
//    - Persist the result to Firestore (per chat subcollection)
//    - Send a formatted message to Slack
//    - Update execution status on the setting doc
// Notes:
// - Keep it simple and sequential for clarity.
// - All heavy lifting is delegated to lib functions.
// -----------------------------------------------------------------------------

import type { ReportSetting } from "../../types/reportSetting.js";
import { db } from "../firebase.js";
import { buildReportPayload } from "./buildReportPayload.js";
import { summarizeWithAI } from "./summarizeWithAI.js";
import { saveReportToFirestore } from "./saveReportToFirestore.js";
import { sendReportToSlack } from "./sendReportToSlack.js";
import { updateReportStatus } from "./updateReportStatus.js";

/**
 * Entry point for the weekly report job.
 * - Fetches enabled settings
 * - Processes each target sequentially
 */
export async function runWeeklyReport(): Promise<void> {
  console.log("▶ Starting weekly report job...");

  // ---------------------------------------------------------------------------
  // Step 1. Fetch active report settings
  // ---------------------------------------------------------------------------
  const snap = await db
    .collection("reports_settings")
    .where("enabled", "==", true)
    .get();

  if (snap.empty) {
    console.log("No active report settings found. Exiting.");
    return;
  }

  const settings = snap.docs.map((d: any) => ({
    id: d.id,
    ...d.data(),
  })) as Array<ReportSetting & { id: string }>;

  console.log(`Found ${settings.length} active settings.`);

  // ---------------------------------------------------------------------------
  // Step 2. Process each setting sequentially
  // ---------------------------------------------------------------------------
  for (const setting of settings) {
    const targetLabel = `${setting.target.type}:${setting.target.id}`;
    console.log(`\n→ Processing target: ${targetLabel}`);

    try {
      // -----------------------------------------------------------------------
      // Step 3 + 4. Fetch messages & build AI request payload
      // - buildReportPayload internally loads messages for the recent window
      // -----------------------------------------------------------------------
      const { body, isNoMessages } = await buildReportPayload(
        setting.target.id,
        setting.name,
      );

      // -----------------------------------------------------------------------
      // Step 5. Generate summary with Vertex AI (Gemini)
      // - result: { summary, bullets, usage, finishReason }
      // -----------------------------------------------------------------------
      const result = await summarizeWithAI(body);
      console.log("Summary (first 200 chars):", result.summary.slice(0, 200));
      console.log("FinishReason:", result.finishReason);

      // -----------------------------------------------------------------------
      // Step 6. Save to Firestore per chat:
      // Path: tg_chats/{chatId}/reports/{autoId}
      // -----------------------------------------------------------------------
      await saveReportToFirestore(setting.target.id, result);
      console.log("✅ Report saved to Firestore.");

      // -----------------------------------------------------------------------
      // Step 7. Deliver to Slack (only when there were messages)
      // - Prefer input.target.name for a human-readable title
      // -----------------------------------------------------------------------
      const hasBullets =
        Array.isArray(result.bullets) && result.bullets.length > 0;
      if (!isNoMessages && hasBullets) {
        await sendReportToSlack(result, setting.name);
        console.log("✅ Report delivered to Slack.");
      } else {
        console.log(
          `⚪ Slack notification skipped: ${
            isNoMessages ? "no messages in period" : "no bullets generated"
          }`,
        );
      }

      // -----------------------------------------------------------------------
      // Step 8. Update setting execution status (success)
      // -----------------------------------------------------------------------
      await updateReportStatus(setting.id, "success");
    } catch (err) {
      console.error(`❌ Failed for ${targetLabel}:`, err);

      // ---------------------------------------------------------------------
      // Step 9. Update setting execution status (error)
      // ---------------------------------------------------------------------
      await updateReportStatus(setting.id, "error", err);

      // (Optional) Decide whether to continue or break.
      // For now, continue to next setting to avoid blocking others.
    }
  }

  console.log("\n✅ Weekly report job finished.");
}

/* ----------------------------- Future TODOs -------------------------------
 * - Idempotency guard: prevent double-run by writing a short-lived lock doc.
 * - Rate limiting: throttle AI calls if many settings exist.
 * - Observability: export usage/finishReason to a metrics sink (e.g., BigQuery).
 * - Config: move fixed window days / model ID to env-based config if needed.
 * ------------------------------------------------------------------------- */
