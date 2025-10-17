// -----------------------------------------------------------------------------
// Build the AI request payload for the weekly report.
// - Public API:
//    - buildReportPayload(): returns { body, input } for AI call
//    - buildInputContext(): returns normalized input context only
// - Internals:
//    - fetchWeeklyMessages(): Firestore query + shape normalization
//    - computePeriod(): derive [startISO, endISO] for JST week window
//    - toIsoWithOffset(): construct ISO string with explicit offset
// -----------------------------------------------------------------------------

// ===== Imports =====
import { Timestamp, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { loadReportAiSectionPrompt } from "./promptLoader.js";
import type { MessageType } from "../../types/message.js";
import { isFromInternal } from "../isInternal.js";

// ===== Types =====

/** Minimal input context consumed by the AI system prompt. */
export type InputContext = {
  period: { startISO: string; endISO: string; tz: string };
  target: { type: "chat"; id: string; name: string };
  messages: InputContextMessage[];
};

/** One normalized message item passed to the AI. */
export type InputContextMessage = {
  msgId: string;
  sender: {
    id: string;
    displayName: string;
    username: string;
  };
  sentAt: string; // ISO 8601
  text: string;
  type: MessageType;
  isFromInternal: boolean; // currently always computed from sender id
};

/** Optional period options (stored as strings; no timezone math performed). */
export type BuildOptions = {
  startISO?: string;
  endISO?: string;
  tz?: string; // e.g., "Asia/Tokyo" (stored only)
};

/** Vertex (Gemini) compatible request body (JSON-in/JSON-out). */
export type VertexRequestBody = {
  systemInstruction: { parts: { text: string }[] };
  contents: { role: "user"; parts: { text: string }[] }[];
  generationConfig: {
    responseMimeType: "application/json";
    temperature?: number;
    maxOutputTokens?: number;
    // Keep as any to avoid changing the current JSON schema shape.
    responseSchema?: any;
  };
};

// ===== Public API =====

/**
 * Build the final request body for the AI call along with the raw input context.
 * - Loads the system prompt if not provided.
 * - Gathers weekly messages and normalizes the shape.
 */
export async function buildReportPayload(
  chatId: string,
  chatTitle: string,
  opts: BuildOptions = {},
  systemText?: string,
): Promise<{ body: VertexRequestBody }> {
  const sysText = systemText ?? (await loadReportAiSectionPrompt());
  const input = await buildInputContext(chatId, chatTitle, opts);

  const body: VertexRequestBody = {
    systemInstruction: { parts: [{ text: sysText }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens: 4000,
      // JSON Schema for the AI output (unchanged).
      responseSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          bullets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                point: { type: "string" },
                timeline: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      when: { type: "string" },
                      event: { type: "string" },
                      owner: { type: "string" },
                      status: {
                        type: "string",
                        enum: ["planned", "in_progress", "done", "blocked"],
                      },
                      deadline: { type: "boolean" },
                    },
                    required: ["when", "event"],
                  },
                },
                evidence: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      msgId: { type: "string" },
                      sender: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          displayName: { type: "string" },
                          username: { type: "string" },
                        },
                        required: ["id"],
                      },
                      sentAt: { type: "string" },
                      textExcerpt: { type: "string" },
                      reason: {
                        type: "string",
                        enum: [
                          "deadline_source",
                          "requirement_source",
                          "decision_source",
                          "schedule_confirmation",
                          "misc",
                        ],
                      },
                    },
                    required: ["msgId", "sender"],
                  },
                },
              },
              required: ["point"], // timeline/evidence are optional
            },
          },
        },
        required: ["summary", "bullets"],
      },
    },
  };

  return { body };
}

/**
 * Build only the input context (period + target + normalized messages).
 */
export async function buildInputContext(
  chatId: string,
  chatTitle: string,
  opts: BuildOptions = {},
): Promise<InputContext> {
  const { startISO, endISO, tz } = computePeriod(opts);
  const { messages } = await fetchWeeklyMessages(chatId, startISO, endISO);

  return {
    period: { startISO, endISO, tz },
    target: { type: "chat", id: chatId, name: chatTitle },
    messages,
  };
}

// ===== Internals =====

/**
 * Query Firestore for messages within [startISO, endISO) and normalize them.
 */
async function fetchWeeklyMessages(
  chatId: string,
  startISO: string,
  endISO: string,
): Promise<{ messages: InputContextMessage[] }> {
  const startTs = Timestamp.fromDate(new Date(startISO));
  const endTs = Timestamp.fromDate(new Date(endISO));
  const col = db.collection("tg_chats").doc(chatId).collection("messages");

  const snap = await col
    .where("sentAt", ">=", startTs)
    .where("sentAt", "<", endTs)
    .orderBy("sentAt", "asc")
    .get();

  const out: InputContextMessage[] = [];

  snap.forEach((doc: QueryDocumentSnapshot) => {
    const d = doc.data() as any;

    // msgId
    const msgId: string =
      d.messageId?.toString?.() ?? d.msgId?.toString?.() ?? doc.id;

    // sentAt → ISO
    const sentAtIso =
      d.sentAt instanceof Timestamp
        ? d.sentAt.toDate().toISOString()
        : d.raw?.date
          ? new Date(Number(d.raw.date) * 1000).toISOString()
          : undefined;

    // sender basics
    const senderId: string | undefined =
      d.fromUserId?.toString?.() ?? d.raw?.from?.id?.toString?.();
    const username: string | undefined =
      d.fromUsername ?? d.raw?.from?.username;
    const displayName =
      [d.raw?.from?.first_name, d.raw?.from?.last_name]
        .filter(Boolean)
        .join(" ") || undefined;

    // message type fallback
    const type: MessageType =
      d.type ??
      (d.new_chat_member || d.new_chat_members || d.new_chat_participant
        ? "member_join"
        : "text");

    // text (optional in some event messages)
    const text: string | undefined = d.text ?? d.raw?.text ?? undefined;

    // safe fallbacks
    const safeSenderId = senderId ?? "";
    const safeUsername = username ?? "";
    const safeDisplayName =
      displayName ??
      (safeUsername || (safeSenderId ? `user_${safeSenderId}` : "unknown"));

    const safeSentAt = sentAtIso ?? startISO; // fallback to period start if missing
    const safeText = text ?? "";

    out.push({
      msgId,
      sender: {
        id: safeSenderId,
        displayName: safeDisplayName,
        username: safeUsername,
      },
      sentAt: safeSentAt,
      text: safeText,
      type,
      isFromInternal: isFromInternal(safeSenderId),
    });
  });

  return { messages: out };
}

// ===== Period calculation (JST) =====

/**
 * Compute [startISO, endISO] in JST.
 * - Default: end = today 00:00 JST, start = end - 7 days.
 * - If opts.startISO & opts.endISO are provided, use those verbatim.
 */
function computePeriod(opts: BuildOptions) {
  const tz = opts.tz ?? "Asia/Tokyo";
  if (opts.startISO && opts.endISO)
    return { startISO: opts.startISO, endISO: opts.endISO, tz };

  // JST offset is fixed at UTC+9 (no DST in Japan).
  const OFFSET_MIN = 9 * 60;
  const now = new Date();

  // Pseudo-JST date: add offset (min) to UTC clock, then read via UTC getters.
  const nowJst = new Date(now.getTime() + OFFSET_MIN * 60_000);
  const y = nowJst.getUTCFullYear();
  const m = nowJst.getUTCMonth();
  const d = nowJst.getUTCDate();

  // "today 00:00" in JST
  const endLocalMs = Date.UTC(y, m, d, 0, 0, 0);
  const startLocalMs = endLocalMs - 7 * 86_400_000; // 7 days

  const endISO = toIsoWithOffset(endLocalMs, OFFSET_MIN);
  const startISO = toIsoWithOffset(startLocalMs, OFFSET_MIN);

  return { startISO, endISO, tz };
}

/**
 * Build an ISO-8601 string with explicit timezone offset (e.g., +09:00).
 * Accepts a "local" millisecond epoch and an offset in minutes.
 */
function toIsoWithOffset(localMs: number, offsetMin: number): string {
  const d = new Date(localMs);
  const p = (n: number) => n.toString().padStart(2, "0");
  const y = d.getUTCFullYear();
  const M = p(d.getUTCMonth() + 1);
  const D = p(d.getUTCDate());
  const H = p(d.getUTCHours());
  const m = p(d.getUTCMinutes());
  const s = p(d.getUTCSeconds());
  const sign = offsetMin >= 0 ? "+" : "-";
  const ah = p(Math.floor(Math.abs(offsetMin) / 60));
  const am = p(Math.abs(offsetMin) % 60);
  return `${y}-${M}-${D}T${H}:${m}:${s}${sign}${ah}:${am}`; // e.g., ...T00:00:00+09:00
}
