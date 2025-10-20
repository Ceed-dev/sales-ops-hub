// -----------------------------------------------------------------------------
// Command handler for AI weekly report settings.
//
// Supported actions:
//   - "get": List or lookup report settings with filters/search and field picking
//   - "set": Update `enabled` for given chat IDs
//
// Notes:
//   - Pagination is intentionally disabled for now (kept as commented helpers).
//   - Transport-agnostic: usable from HTTP routes, Slack commands, or other callers.
// -----------------------------------------------------------------------------

import { Request, Response } from "express";
import { db } from "../../firebase.js";
import { ReportSetting } from "../../../types/reportSetting.js";
import { formatJST } from "../../../utils/time.js";
import { FieldPath } from "firebase-admin/firestore";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Firestore collection name for report settings. */
const COLLECTION = "reports_settings";

/** Default list size for general GET listing. */
const DEFAULT_LIMIT = 50;

/** Hard upper bound for safety when a larger cap is needed (e.g., exact lookups). */
const MAX_LIMIT = 500;

/**
 * NOTE: Pagination helpers (disabled).
 * Keep these stubs for future use when we re-enable cursor-based pagination.
 */
// const encodeCursor = (updatedAtMs: number, id: string) =>
//   Buffer.from(JSON.stringify({ u: updatedAtMs, id }), "utf8").toString("base64");
// const decodeCursor = (s: string | undefined) => {
//   if (!s) return null;
//   try {
//     const { u, id } = JSON.parse(Buffer.from(s, "base64").toString("utf8"));
//     return { u: Number(u), id: String(id) };
//   } catch {
//     return null;
//   }
// };

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Minimal response shape returned to clients. */
type LeanSetting = {
  id: string;
  chatId: string | null;
  name: string;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
};

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Clamp a numeric limit to [min .. max]; fall back to default if invalid.
 */
function clampLimit(
  value: unknown,
  fallback: number,
  max: number,
  min = 1,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

/**
 * Project a Firestore doc into a minimal response object.
 */
function toLean(doc: FirebaseFirestore.QueryDocumentSnapshot): LeanSetting {
  const data = doc.data() as ReportSetting;
  return {
    id: doc.id,
    chatId: data.target?.id ?? null,
    name: data.name ?? "(no name)",
    enabled: !!data.enabled,
    createdAt: data.createdAt ? formatJST(data.createdAt) : null,
    updatedAt: data.updatedAt ? formatJST(data.updatedAt) : null,
    lastRunAt: data.lastRunAt ? formatJST(data.lastRunAt) : null,
    lastSuccessAt: data.lastSuccessAt ? formatJST(data.lastSuccessAt) : null,
  };
}

/**
 * Pick only requested fields from an object.
 * If `fields` is empty/invalid, return the object as-is.
 */
function pickFields<T extends Record<string, unknown>>(
  obj: T,
  fields?: string[],
): Partial<T> | T {
  if (!Array.isArray(fields) || fields.length === 0) return obj;
  const out: Partial<T> = {};
  for (const k of fields) if (k in obj) (out as any)[k] = obj[k as keyof T];
  return out;
}

/**
 * Execute Firestore `in` queries in batches of 10 values (Firestore constraint).
 */
async function queryInBatches(
  base: FirebaseFirestore.Query,
  field: string,
  values: string[],
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const results: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (let i = 0; i < values.length; i += 10) {
    const chunk = values.slice(i, i + 10);
    const snap = await (
      base.where(field, "in", chunk) as FirebaseFirestore.Query
    ).get();
    results.push(...snap.docs);
  }
  return results;
}

/**
 * Sort by updatedAt (desc), then documentId (desc).
 */
function sortByUpdatedAtDescIdDesc(
  a: FirebaseFirestore.QueryDocumentSnapshot,
  b: FirebaseFirestore.QueryDocumentSnapshot,
): number {
  const au =
    (a.get("updatedAt")?.toDate?.() as Date | undefined)?.getTime() ?? 0;
  const bu =
    (b.get("updatedAt")?.toDate?.() as Date | undefined)?.getTime() ?? 0;
  if (au !== bu) return bu - au;
  return b.id.localeCompare(a.id);
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function handleConfigCommand(req: Request, res: Response) {
  try {
    const {
      action = "get",

      // Filters for "get"
      chats = [],
      names = [],
      enabled, // boolean (optional)
      q, // string: prefix match against `nameLower`
      limit = DEFAULT_LIMIT, // numeric (list size; pagination disabled)

      // Field projection (optional)
      fields,
    } = req.body || {};

    const colRef = db.collection(COLLECTION);

    // -----------------------------------------------------------------------
    // 1) GET
    // -----------------------------------------------------------------------
    if (action === "get") {
      // A) Exact lookup by chat IDs and/or exact names.
      // Small result set expected, so no cursor or pagination.
      const hasChats = Array.isArray(chats) && chats.length > 0;
      const hasNames = Array.isArray(names) && names.length > 0;

      if (hasChats || hasNames) {
        let base: FirebaseFirestore.Query = colRef;
        if (typeof enabled === "boolean")
          base = base.where("enabled", "==", enabled);

        const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
        if (hasChats)
          docs.push(...(await queryInBatches(base, "target.id", chats)));
        if (hasNames) docs.push(...(await queryInBatches(base, "name", names)));

        // De-duplicate, sort, then clamp to a safe upper bound.
        const uniq = new Map(docs.map((d) => [d.id, d]));
        const sorted = [...uniq.values()].sort(sortByUpdatedAtDescIdDesc);
        const lim = clampLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);
        const sliced = sorted.slice(0, lim);

        const settings = sliced.map((d) => pickFields(toLean(d), fields));
        return res.status(200).json({
          count: settings.length,
          settings,
          nextCursor: null, // pagination disabled
        });
      }

      // B) Listing mode (filter & optional prefix search).
      let qref: FirebaseFirestore.Query = colRef;

      if (typeof enabled === "boolean") {
        qref = qref.where("enabled", "==", enabled);
      }

      if (typeof q === "string" && q.trim() !== "") {
        // Prefix search on `nameLower`
        const lower = q.trim().toLowerCase();
        qref = qref
          .where("nameLower", ">=", lower)
          .where("nameLower", "<", lower + "\uf8ff")
          .orderBy("nameLower"); // must order by the same field in range query
      } else {
        // Default ordering for listing mode
        qref = qref
          .orderBy("updatedAt", "desc")
          .orderBy(FieldPath.documentId());
      }

      // Pagination disabled: just clamp to a safe small limit.
      const lim = clampLimit(limit, DEFAULT_LIMIT, DEFAULT_LIMIT);
      qref = qref.limit(lim);

      const snap = await qref.get();
      const settings = snap.docs.map((d) => pickFields(toLean(d), fields));

      return res.status(200).json({
        count: settings.length,
        settings,
        nextCursor: null, // pagination disabled
      });
    }

    // -----------------------------------------------------------------------
    // 2) SET: update `enabled` by chat IDs
    // -----------------------------------------------------------------------
    if (action === "set") {
      if (!Array.isArray(chats) || chats.length === 0) {
        return res.status(400).json({
          error: "Missing required parameter: chats (array of chat IDs).",
        });
      }
      if (typeof enabled !== "boolean") {
        return res
          .status(400)
          .json({ error: "Missing or invalid parameter: enabled (boolean)." });
      }

      const updated: string[] = [];
      const failed: { chatId: string; reason: string }[] = [];

      for (const chatId of chats as string[]) {
        try {
          const snapshot = await colRef
            .where("target.id", "==", chatId)
            .limit(1)
            .get();
          const first = snapshot.docs[0];
          if (!first) {
            failed.push({ chatId, reason: "No matching document found." });
            continue;
          }
          await first.ref.update({ enabled, updatedAt: new Date() });
          updated.push(chatId);
        } catch (err: unknown) {
          const reason =
            (err as any)?.message ??
            (typeof err === "string" ? err : "Unknown error");
          failed.push({ chatId, reason });
        }
      }

      return res.status(200).json({
        message: "Update complete.",
        updatedCount: updated.length,
        failedCount: failed.length,
        updated,
        failed,
      });
    }

    // -----------------------------------------------------------------------
    // Unsupported action
    // -----------------------------------------------------------------------
    return res
      .status(400)
      .json({ error: `Unsupported action: ${String(action)}` });
  } catch (error: unknown) {
    console.error("[handleConfigCommand] Error:", error);
    return res.status(500).json({
      error: "Failed to process config command.",
      details:
        (error as any)?.message ??
        (typeof error === "string" ? error : "Unknown error"),
    });
  }
}
