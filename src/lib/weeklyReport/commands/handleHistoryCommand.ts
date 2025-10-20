// -----------------------------------------------------------------------------
// Fetch previously generated weekly reports from Firestore.
// - If `reportId` is provided: return that single report (detail mode).
// - Otherwise: return a list ordered by newest first (list mode).
// - Optional: re-post the fetched report to Slack.
//
// Firestore layout:
//   tg_chats/{chatId}/reports/{reportId}
//
// Notes:
// - Default list `limit` = 3
// - Optional period filter: [startISO, endISO) on createdAt
// - For Slack, we reuse sendReportToSlack(result, chatTitle)
// -----------------------------------------------------------------------------

import { Request, Response } from "express";
import { FieldPath } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import type { ReportSetting } from "../../../types/reportSetting.js";
import { sendReportToSlack } from "../sendReportToSlack.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type HistoryRequestBody = {
  chatId?: string;
  reportId?: string;
  limit?: number; // default 3 (capped)
  startISO?: string; // optional: lower bound (inclusive)
  endISO?: string; // optional: upper bound (exclusive)
  notifySlack?: boolean; // default false
  fields?: string[]; // optional: projection for list items
};

type LeanReport = {
  id: string;
  createdAt: string | null;
  finishReason?: string | null;
  summaryFirst200?: string;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 50;
const REPORTS_SETTINGS = "reports_settings";

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

/** Return a plain subset of obj when `fields` is provided, otherwise original obj. */
function pickFields<T extends Record<string, any>>(obj: T, fields?: string[]) {
  if (!Array.isArray(fields) || fields.length === 0) return obj;
  const out: Partial<T> = {};
  for (const k of fields) {
    if (k in obj) (out as any)[k] = obj[k as keyof T];
  }
  return out;
}

/** Convert Firestore doc to a lean list item. */
function toLeanReport(
  doc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>,
): LeanReport {
  const d = doc.data() as any;

  const createdAtIso =
    d.createdAt?.toDate?.()?.toISOString?.() ??
    (typeof d.createdAt === "string" ? d.createdAt : null);

  // Some historical rows may store summary as JSON string; keep it safe.
  const summaryText =
    typeof d.summary === "string"
      ? d.summary
      : typeof d.summary?.toString === "function"
        ? d.summary.toString()
        : "";

  return {
    id: doc.id,
    createdAt: createdAtIso,
    finishReason: d.finishReason ?? null,
    summaryFirst200: summaryText.slice(0, 200),
  };
}

/** Normalize stored report to { summary, bullets } for Slack re-post. */
function toSlackResult(d: any): { summary: string; bullets: any[] } {
  // Some schemas stored JSON-stringified {summary, bullets} in `summary`.
  if (typeof d.summary === "string" && d.summary.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(d.summary);
      if (parsed && typeof parsed === "object") {
        return {
          summary: String(parsed.summary ?? ""),
          bullets: Array.isArray(parsed.bullets) ? parsed.bullets : [],
        };
      }
    } catch {
      // fall through to plain string mode
    }
  }
  return {
    summary: typeof d.summary === "string" ? d.summary : "",
    bullets: Array.isArray(d.bullets) ? d.bullets : [],
  };
}

/** Resolve human-readable chat title from reports_settings. */
async function resolveChatTitle(chatId: string): Promise<string> {
  const snap = await db
    .collection(REPORTS_SETTINGS)
    .where("target.id", "==", chatId)
    .limit(1)
    .get();

  const doc = snap.docs[0];
  if (!doc) return "(no name)";

  const setting = doc.data() as ReportSetting;
  return setting.name ?? "(no name)";
}

/** Parse ISO-8601 to Date or return null when invalid/empty. */
function parseISO(iso?: string): Date | null {
  if (!iso || typeof iso !== "string") return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Clamp list limit safely. */
function clampLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(n), MAX_LIMIT));
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function handleHistoryCommand(req: Request, res: Response) {
  try {
    const {
      chatId,
      reportId,
      limit: limitRaw,
      startISO,
      endISO,
      notifySlack = false,
      fields,
    } = (req.body ?? {}) as HistoryRequestBody;

    // Basic validation
    if (!chatId || typeof chatId !== "string") {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'chatId' (string)." });
    }

    const startDate = parseISO(startISO);
    const endDate = parseISO(endISO);
    if (startISO && !startDate) {
      return res.status(400).json({ error: "Invalid 'startISO' (ISO-8601)." });
    }
    if (endISO && !endDate) {
      return res.status(400).json({ error: "Invalid 'endISO' (ISO-8601)." });
    }
    if (startDate && endDate && startDate >= endDate) {
      return res.status(400).json({ error: "'startISO' must be < 'endISO'." });
    }

    const col = db.collection("tg_chats").doc(chatId).collection("reports");

    // -----------------------------------------------------------------------
    // Detail mode: reportId specified
    // -----------------------------------------------------------------------
    if (reportId) {
      const doc = await col.doc(reportId).get();
      if (!doc.exists) {
        return res.status(404).json({
          error: `Report not found for chatId=${chatId}, reportId=${reportId}`,
        });
      }

      const data = doc.data() as any;

      const report = {
        id: doc.id,
        createdAt:
          data.createdAt?.toDate?.()?.toISOString?.() ??
          (typeof data.createdAt === "string" ? data.createdAt : null),
        finishReason: data.finishReason ?? null,
        summary:
          typeof data.summary === "string"
            ? data.summary
            : String(data.summary ?? ""),
        bullets: Array.isArray(data.bullets) ? data.bullets : [],
        usage: data.usage ?? undefined,
      };

      // Optional Slack re-post (single item)
      if (notifySlack) {
        const chatTitle = await resolveChatTitle(chatId);
        const payload = toSlackResult(data);
        await sendReportToSlack(payload, chatTitle);
      }

      return res.status(200).json({ mode: "get", report });
    }

    // -----------------------------------------------------------------------
    // List mode: newest first, with optional period filter
    // -----------------------------------------------------------------------
    let q: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = col;

    if (startDate) q = q.where("createdAt", ">=", startDate);
    if (endDate) q = q.where("createdAt", "<", endDate);

    // Newest first; tie-breaker by docId desc for deterministic ordering.
    q = q.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");

    const lim = clampLimit(limitRaw ?? DEFAULT_LIMIT);
    q = q.limit(lim);

    const snap = await q.get();
    const docs = snap.docs;

    const reports = docs.map((d) => pickFields(toLeanReport(d), fields));

    // Optional Slack re-post for the first (latest) item only
    if (notifySlack && docs[0]) {
      const chatTitle = await resolveChatTitle(chatId);
      const latestData = docs[0].data();
      const payload = toSlackResult(latestData);
      await sendReportToSlack(payload, chatTitle);
    }

    return res.status(200).json({
      mode: "list",
      count: reports.length,
      reports,
    });
  } catch (error: any) {
    console.error("[handleHistoryCommand] Error:", error);
    return res.status(500).json({
      error: "Failed to fetch weekly report history.",
      details: error?.message ?? String(error),
    });
  }
}
