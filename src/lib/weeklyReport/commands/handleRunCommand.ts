// -----------------------------------------------------------------------------
// Trigger the existing weekly-report pipeline for a single chat on demand.
// This is a thin transport-agnostic wrapper around the existing workflow:
//   - compute period (or use provided)
//   - build AI payload (internally fetches messages)
//   - summarize with AI
//   - optionally persist & optionally notify Slack
//
// Args (req.body):
//   chatId: string (required)
//   startISO?: string (optional; ISO-8601 with offset)
//   endISO?: string   (optional; ISO-8601 with offset)
//   tz?: string       (optional; stored as label; default "Asia/Tokyo")
//   dryRun?: boolean  (optional; default true)                // if true, do NOT persist
//   notifySlack?: boolean (optional; default false)           // if true, send Slack
//
// Response (JSON):
//   { message, dryRun, notifySlack, period, latencyMs, resultPreview }
//   // resultPreview is lightweight (first 200 chars) by design.
// -----------------------------------------------------------------------------

import { Request, Response } from "express";
import { db } from "../../firebase.js";
import type { ReportSetting } from "../../../types/reportSetting.js";

// Reuse existing weekly-report utilities (no logic duplication)
import { computePeriod, buildReportPayload } from "../buildReportPayload.js";
import { summarizeWithAI } from "../summarizeWithAI.js";
import { saveReportToFirestore } from "../saveReportToFirestore.js";
import { sendReportToSlack } from "../sendReportToSlack.js";
import { updateReportStatus } from "../updateReportStatus.js";
import type { BuildOptions as PayloadBuildOptions } from "../buildReportPayload.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type RunRequestBody = {
  chatId?: string;
  startISO?: string;
  endISO?: string;
  tz?: string;
  dryRun?: boolean;
  notifySlack?: boolean;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * BuildOptions helper that removes undefined keys
 * (for projects enabling exactOptionalPropertyTypes).
 */
function makeOpts(
  startISO?: string,
  endISO?: string,
  tz?: string,
): PayloadBuildOptions {
  const o: PayloadBuildOptions = {};
  if (typeof startISO === "string") o.startISO = startISO;
  if (typeof endISO === "string") o.endISO = endISO;
  if (typeof tz === "string") o.tz = tz;
  return o;
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function handleRunCommand(req: Request, res: Response) {
  try {
    // -------------------------------------------------------------------------
    // 0) Parse & validate input
    // -------------------------------------------------------------------------
    const {
      chatId,
      startISO,
      endISO,
      tz,
      dryRun = true,
      notifySlack = false,
    } = (req.body ?? {}) as RunRequestBody;

    if (!chatId || typeof chatId !== "string") {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'chatId' (string)." });
    }

    // -------------------------------------------------------------------------
    // 1) Resolve setting (for human-readable title & status updates)
    // -------------------------------------------------------------------------
    const settingSnap = await db
      .collection("reports_settings")
      .where("target.id", "==", chatId)
      .limit(1)
      .get();

    const settingDoc = settingSnap.docs[0];
    if (!settingDoc) {
      return res
        .status(404)
        .json({ error: `No report setting found for chatId=${chatId}` });
    }

    const setting = {
      id: settingDoc.id,
      ...(settingDoc.data() as ReportSetting),
    };
    const chatTitle = setting.name ?? "(no name)";

    // -------------------------------------------------------------------------
    // 2) Period resolution (transparent in response)
    //    NOTE: computePeriod() uses provided start/end if both present,
    //          else falls back to JST default window (today 00:00, minus 7 days).
    // -------------------------------------------------------------------------
    const period = computePeriod(makeOpts(startISO, endISO, tz));

    // -------------------------------------------------------------------------
    // 3) Build AI payload (internally fetches messages in [startISO, endISO))
    // -------------------------------------------------------------------------
    const { body } = await buildReportPayload(chatId, chatTitle, {
      startISO: period.startISO,
      endISO: period.endISO,
      tz: period.tz,
    } satisfies PayloadBuildOptions);

    // -------------------------------------------------------------------------
    // 4) Summarize with AI
    // -------------------------------------------------------------------------
    const t0 = process.hrtime.bigint();
    const result = await summarizeWithAI(body);
    const latencyMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);

    // -------------------------------------------------------------------------
    // 5) Persist if not dry-run
    // -------------------------------------------------------------------------
    if (!dryRun) {
      await saveReportToFirestore(chatId, result);
      await updateReportStatus(setting.id, "success");
    } else {
      // Optional: touch lastRunAt for observability
      // await settingDoc.ref.update({ lastRunAt: new Date(), updatedAt: new Date() }).catch(() => {});
    }

    // -------------------------------------------------------------------------
    // 6) Slack notification (optional; title carries [DRY RUN] if applicable)
    // -------------------------------------------------------------------------
    if (notifySlack) {
      const titleForSlack = dryRun ? `[DRY RUN] ${chatTitle}` : chatTitle;
      await sendReportToSlack(result, titleForSlack);
    }

    // -------------------------------------------------------------------------
    // 7) Respond (lightweight preview; full result is large)
    // -------------------------------------------------------------------------
    return res.status(200).json({
      message: dryRun
        ? "Run completed (dry-run)."
        : "Run completed (persisted).",
      dryRun,
      notifySlack,
      period,
      latencyMs,
      resultPreview: {
        summaryFirst200: result.summary?.slice(0, 200) ?? "",
        finishReason: (result as any)?.finishReason,
      },
    });
  } catch (error: any) {
    console.error("[handleRunCommand] Error:", error);

    // Best-effort: if we can resolve the setting, mark error status
    try {
      const chatId = (req.body as RunRequestBody | undefined)?.chatId;
      if (chatId) {
        const s = await db
          .collection("reports_settings")
          .where("target.id", "==", chatId)
          .limit(1)
          .get();

        const first = s.docs[0] ?? null;
        if (first) {
          await updateReportStatus(first.id, "error", error);
        }
      }
    } catch {
      // ignore secondary error
    }

    return res.status(500).json({
      error: "Failed to run weekly report.",
      details: error?.message ?? String(error),
    });
  }
}
