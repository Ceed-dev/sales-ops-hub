// -----------------------------------------------------------------------------
// External dependencies
// -----------------------------------------------------------------------------
import "dotenv/config";
import express from "express";
import { Timestamp, FieldValue } from "firebase-admin/firestore";

// -----------------------------------------------------------------------------
// Internal libraries (Firebase, utilities, Telegram helpers)
// -----------------------------------------------------------------------------
import { db } from "./lib/firebase.js";
import { isFromInternal } from "./lib/isInternal.js";
import { toUtcDayKey, formatJST } from "./utils/time.js";
import { isDuplicateUpdateId } from "./utils/updateCache.js";

import { detectMessageType } from "./lib/telegram/messageType.js";
import { generateSummary } from "./lib/telegram/summary.js";
import {
  buildNewChatRoomDoc,
  buildChatPartialUpdate,
} from "./lib/telegram/chatDocs.js";
import { updateStats } from "./lib/telegram/stats.js";
import { handleProposalFollowup } from "./lib/telegram/followup.js";

import { runWeeklyReport } from "./lib/weeklyReport/runWeeklyReport.js";
import { ensureReportSetting } from "./lib/weeklyReport/ensureReportSetting.js";

// -----------------------------------------------------------------------------
// Firestore data types
// -----------------------------------------------------------------------------
import type { ChatStatus } from "./types/chat.js";
import type { MessageDoc } from "./types/message.js";
import type { TelegramUserDoc } from "./types/user.js";
import {
  NotificationJobDoc,
  NotificationDeliveryDoc,
} from "./types/notification.js";

// -----------------------------------------------------------------------------
// Express application bootstrap
// - Initialize Express app
// - Enable built-in JSON body parser (with size limit to avoid abuse)
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" })); // default ~100kb, here set to 1MB

// -----------------------------------------------------------------------------
// POST /webhook/telegram
// -----------------------------------------------------------------------------
// Telegram Bot webhook endpoint.
// Called by Telegram when a new update (message, join/leave event, etc.) occurs.
//
// Flow:
// 1) Validate secret token (x-telegram-bot-api-secret-token).
// 2) Validate Content-Type (must be application/json).
// 3) Parse update and ensure idempotency (skip duplicate update_id).
// 4) Pre-process: detect message type & build summary.
// 5) Guard on bot-join:
//    - If our bot was added by a NON-internal user → send Slack alert, leave the
//      chat immediately, and STOP (no DB writes).
//    - If added by an internal user → continue.
// 6) Upsert tg_chats/{chatId}:
//    - First-time: create full chat doc.
//    - Otherwise: partial update (latest message, lastActiveAt, stats snapshot, etc.).
// 7) First-time only (non-private chats):
//    - Ensure reports_settings/{chat:ID:weekly} exists (idempotent).
//    - If created now, send Slack notification (Created at / Added by).
// 8) Save message under tg_chats/{chatId}/messages/{messageId} with TTL
//    (MESSAGE_TTL_DAYS).
// 9) Update chat stats (daily buckets, peaks, per-user counters, etc.).
// 10) Upsert tg_users/{userId} (global per-user snapshot).
// 11) Trigger proposal follow-up job if needed.
// 12) Return 200 (respond quickly to Telegram).
//
// Notes:
// - Bot join/leave events are appended to chat.botActivityHistory.
// - Private (1:1) chats are excluded from creating weekly report settings.
// - Slack notifications are best-effort; failures never block main flow.
// - Duplicate update_ids are skipped via a short in-memory cache.
// - This endpoint currently reads update.message (extend to channel_post if needed).
// -----------------------------------------------------------------------------
app.post("/webhook/telegram", async (req, res) => {
  try {
    // --- 1) Secret token validation ---
    const expected = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    const got = (req.get("x-telegram-bot-api-secret-token") || "").trim();
    if (expected && got !== expected) {
      console.warn("[TG webhook] secret token mismatch");
      return res.sendStatus(401);
    }

    // --- 2) Content-Type validation ---
    const ct = (req.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      console.warn("[TG webhook] invalid content-type:", ct);
      return res.sendStatus(415);
    }

    // --- 3) Read JSON body ---
    const update = req.body;
    console.log("Secret header:", got || "(empty)");
    console.log("[TG webhook] update:\n", JSON.stringify(update, null, 2));

    // --- 4) Idempotency check (skip duplicate update_id) ---
    const updateId = update?.update_id;
    if (typeof updateId === "number" && isDuplicateUpdateId(updateId)) {
      console.log("[TG webhook] duplicate update_id, skipped:", updateId);
      return res.sendStatus(200);
    }

    // --- 5) Pre-processing (type / summary) ---
    const msg = update?.message;
    if (!msg) {
      // No message payload (nothing to do)
      return res.sendStatus(200);
    }

    const BOT_USERNAME = "sales_ops_assistant_bot";
    const type = detectMessageType(msg);
    const summary = generateSummary(msg, type);
    const sentAt = Timestamp.fromMillis((msg.date ?? 0) * 1000);

    // Bot join/leave history (only when applicable)
    let botActivityHistoryEntry: {
      status: ChatStatus;
      ts: FirebaseFirestore.Timestamp;
      reason: string;
    } | null = null;

    if (type === "member_join") {
      const joined = (msg.new_chat_members || []).find(
        (u: any) => u.username === BOT_USERNAME,
      );
      if (joined) {
        // Guard: Bot was added by a non-internal user → notify Slack, leave the chat, stop processing.
        if (!isFromInternal(msg.from?.id)) {
          const chatIdStr = String(msg.chat?.id ?? "");
          const title = (msg.chat?.title ?? "").trim() || "(no title)";
          const fromLabel =
            (msg.from?.username
              ? "@" + msg.from.username
              : [msg.from?.first_name, msg.from?.last_name]
                .filter(Boolean)
                .join(" ") || "Unknown user") + ` (ID: ${msg.from?.id})`;

          // --- Slack notification (best-effort, non-blocking) ---
          try {
            const text = [
              "⚠️ Bot was added by an external user — leaving the chat.",
              `• Title: *${title}*`,
              `• Chat ID: \`${chatIdStr}\``,
              `• At: ${formatJST(Date.now())}`,
              `• Added by: ${fromLabel}`,
            ].join("\n");

            const webhookUrl = process.env.SLACK_WEBHOOK_URL;
            if (!webhookUrl) {
              console.warn(
                "[slack] SLACK_WEBHOOK_URL is not set; skip Slack notification",
              );
            } else {
              const startHr = process.hrtime.bigint();
              const resp = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, mrkdwn: true, link_names: 1 }),
              });
              const durationMs = Number(
                (process.hrtime.bigint() - startHr) / 1_000_000n,
              );

              if (!resp.ok) {
                const body = await resp.text();
                console.warn(
                  `[slack] post failed: ${resp.status} ${body?.slice(0, 300) || ""}`,
                );
              } else {
                console.log(`[slack] notified in ${durationMs}ms`);
              }
            }
          } catch (e) {
            console.warn("[slack] send error:", e);
          }

          // --- Leave the unauthorized chat (best-effort) ---
          try {
            const api = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/leaveChat`;
            const resp = await fetch(api, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatIdStr }),
            });
            if (!resp.ok) {
              const body = await resp.text();
              console.warn(
                `[telegram] leaveChat failed: ${resp.status} ${body?.slice(0, 300) || ""}`,
              );
            }
          } catch (e) {
            console.warn("[telegram] leaveChat error:", e);
          }

          // Stop the webhook here: do not create/update any DB docs for this chat.
          return res.sendStatus(200);
        }

        botActivityHistoryEntry = {
          status: "active",
          ts: sentAt,
          reason: "bot_joined",
        };
      }
    }
    if (type === "member_leave") {
      const left = msg.left_chat_member;
      if (left?.username === BOT_USERNAME) {
        botActivityHistoryEntry = {
          status: "archived",
          ts: sentAt,
          reason: "bot_removed",
        };
      }
    }

    // --- 6) Upsert tg_chats/{chatId} (create or partial update) ---
    const chatId = String(msg.chat.id);
    const chatRef = db.collection("tg_chats").doc(chatId);
    const chatSnap = await chatRef.get();

    if (!chatSnap.exists) {
      // ---------------------------------------------------------------------------
      // 1) Create chat room document (first-time)
      // ---------------------------------------------------------------------------
      const doc = buildNewChatRoomDoc({
        msg,
        type,
        summary,
        sentAt,
        botActivityHistoryEntry,
      });
      await chatRef.set(doc); // merge: false

      // ---------------------------------------------------------------------------
      // 2) Resolve identifiers (title)
      // ---------------------------------------------------------------------------
      const finalTitle = (
        msg.chat?.title ??
        ([msg.chat?.first_name, msg.chat?.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() ||
          (msg.chat?.username
            ? `@${msg.chat.username}`
            : chatId
              ? `chat:${chatId}`
              : "Unknown Chat"))
      )
        .replace(/\s+/g, " ")
        .trim();

      // Skip creating report settings for private (1:1) chats; process only group/supergroup (and channel).
      if (msg.chat?.type !== "private") {
        // ---------------------------------------------------------------------------
        // 3) Ensure weekly report setting (idempotent)
        // ---------------------------------------------------------------------------
        const created = await ensureReportSetting({
          target: { type: "chat", id: chatId },
          name: finalTitle,
        });

        // ---------------------------------------------------------------------------
        // 4) Slack notify only when a setting was newly created
        // ---------------------------------------------------------------------------
        if (created) {
          const text = [
            "🆕 New chat detected — weekly report setting has been created.",
            `• Title: *${finalTitle}*`,
            `• Chat ID: \`${chatId}\``,
            `• Created at: ${formatJST(Date.now())}`,
            `• Added by: ${msg.from?.username ? "@" + msg.from.username : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Unknown user"} (ID: ${msg.from?.id})`,
          ].join("\n");

          const webhookUrl = process.env.SLACK_WEBHOOK_URL;

          if (!webhookUrl) {
            console.warn(
              "[slack] SLACK_WEBHOOK_URL is not set; skip Slack notification",
            );
          } else {
            const startHr = process.hrtime.bigint();

            try {
              const resp = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, mrkdwn: true, link_names: 1 }),
              });

              const durationMs = Number(
                (process.hrtime.bigint() - startHr) / 1_000_000n,
              );

              if (!resp.ok) {
                const respText = await resp.text();
                console.warn(
                  `[slack] post failed: ${resp.status} ${respText?.slice(0, 300) || ""}`,
                );
              } else {
                console.log(`[slack] notified in ${durationMs}ms`);
              }
            } catch (e) {
              console.warn("[slack] send error:", e);
            }
          }
        }
      }
    } else {
      // Later: partial update (latestMessage, lastActiveAt, etc.)
      const updateData = buildChatPartialUpdate({
        msg,
        type,
        summary,
        sentAt,
        botActivityHistoryEntry,
      });

      // botActivityHistory append uses arrayUnion on save
      if (botActivityHistoryEntry) {
        await chatRef.set(
          {
            ...updateData,
            botActivityHistory: FieldValue.arrayUnion(botActivityHistoryEntry),
          },
          { merge: true },
        );
      } else {
        await chatRef.set(updateData, { merge: true });
      }
    }

    console.log("[TG webhook] tg_chats upsert done:", chatId);

    // --- 7) Save message into subcollection tg_chats/{chatId}/messages/{messageId} ---
    const msgRef = chatRef.collection("messages").doc(String(msg.message_id));

    const ttlDays = Number(process.env.MESSAGE_TTL_DAYS || "30");
    const expireAt = Timestamp.fromMillis(
      sentAt.toMillis() + ttlDays * 24 * 60 * 60 * 1000,
    );

    const messageDoc: MessageDoc = {
      chatId,
      messageId: String(msg.message_id),
      updateId: update.update_id,
      fromUserId: String(msg.from.id),
      fromUsername: msg.from.username ?? null,
      isBot: !!msg.from.is_bot,
      type,
      sentAt,
      expireAt,
      raw: msg,
    };

    await msgRef.set(messageDoc, { merge: false });
    console.log("[TG webhook] message saved:", chatId, msg.message_id);

    // --- 8) Update chat stats (counts, daily buckets, peaks, byUser, etc.) ---
    await updateStats(chatRef, msg, type);

    // --- 9) Upsert tg_users/{userId} (global per-user snapshot) ---
    const userId = String(msg.from.id);
    const userRef = db.collection("tg_users").doc(userId);
    const userSnap = await userRef.get();

    const now = Timestamp.now();
    const dayKey = toUtcDayKey(sentAt.toMillis());

    // Latest activity candidate (used both for create and update)
    const newLatestActivity = {
      messageId: String(msg.message_id),
      chatId,
      chatTitle: msg.chat.title ?? "",
      type,
      sentAt,
      summary,
      messageRef: msgRef,
    };

    if (!userSnap.exists) {
      // First-time user: create a full document
      const newUser: TelegramUserDoc = {
        userId,
        isBot: !!msg.from.is_bot,
        username: msg.from.username ?? null,
        firstName: msg.from.first_name ?? "",
        lastName: msg.from.last_name ?? null,
        createdAt: now,
        lastSeenAt: sentAt,
        linkedChatIds: [chatId],
        distinctChats: 1,
        counters: { totalMessages: 1 },
        daily: { [dayKey]: { messageCount: 1 } },
        aggregated: {
          last7Days: { messageCount: 0, avgPerDay: 0 },
          last30Days: { messageCount: 0, avgPerDay: 0 },
          last90Days: { messageCount: 0, avgPerDay: 0 },
          peakPerDay: { date: "", count: 0 },
        },
        latestActivity: newLatestActivity,
      };
      await userRef.set(newUser, { merge: false });
    } else {
      // Existing user: partial update
      const prevUser = userSnap.data() as TelegramUserDoc;

      // Update username only when it changed (nullable-safe)
      const usernameUpdate =
        msg.from.username && msg.from.username !== prevUser.username
          ? msg.from.username
          : (prevUser.username ?? null);

      // Update chatTitle only when it changed
      const chatTitleUpdate =
        prevUser.latestActivity?.chatTitle !== msg.chat.title
          ? (msg.chat.title ?? "")
          : (prevUser.latestActivity?.chatTitle ?? "");

      const latestActivity = {
        ...newLatestActivity,
        chatTitle: chatTitleUpdate,
      };

      await userRef.set(
        {
          isBot: !!msg.from.is_bot,
          username: usernameUpdate,
          firstName: msg.from.first_name ?? "",
          lastName: msg.from.last_name ?? null,
          lastSeenAt: sentAt,
          latestActivity,
          linkedChatIds: FieldValue.arrayUnion(chatId),
          counters: { totalMessages: FieldValue.increment(1) },
          daily: { [dayKey]: { messageCount: FieldValue.increment(1) } },
          distinctChats: FieldValue.increment(0), // keep in sync with arrayUnion result
        },
        { merge: true },
      );
    }

    console.log("[TG webhook] tg_users upsert done:", userId);

    // --- 10) Proposal follow-up (enqueue job if needed) ---
    try {
      await handleProposalFollowup({ msg, type, sentAt, chatRef, msgRef });
    } catch (e) {
      console.error("[followup] handleProposalFollowup error:", e);
    }

    // --- 11) Done ---
    return res.sendStatus(200);
  } catch (e) {
    console.error("[/webhook/telegram] error:", e);
    return res.sendStatus(500);
  }
});

// -----------------------------------------------------------------------------
// POST /tasks/notifications
// -----------------------------------------------------------------------------
// Handler for scheduled notification jobs (triggered by Google Cloud Tasks).
//
// Flow:
// 1. Cloud Tasks POSTs { jobId } to this endpoint at the scheduled time.
// 2. The job is looked up from Firestore (notificationJobs/{jobId}).
// 3. Retry / deduplication / max-attempt guards are enforced.
// 4. A Slack notification is attempted (via Incoming Webhook).
// 5. Result (success / failure) is logged in notificationDeliveries/{deliveryId}.
// 6. The job document is deleted when completed or permanently failed.
//
// Notes:
// - Called only by Cloud Tasks (validated via User-Agent).
// - Retryable errors (429/5xx/exception) → HTTP 500 → Cloud Tasks retries.
// - Non-retryable errors (400系) → HTTP 200 + log + job deleted.
// - Prevents double-send with `sentOnce` guard in job document.
// -----------------------------------------------------------------------------
app.post("/tasks/notifications", async (req, res) => {
  const startHr = process.hrtime.bigint();
  const startedAt = Timestamp.now();

  // --- Retry attempt (0-origin → +1 for human-readable) ---
  const attempt = Number(req.get("X-Cloud-Tasks-TaskRetryCount") || 0) + 1;
  const MAX_ATTEMPTS = 5;

  // --- Basic header checks ---
  const ua = req.get("User-Agent") || req.get("user-agent") || "";
  const isCloudTasks = ua.includes("Google-Cloud-Tasks");
  if (!isCloudTasks) return res.status(403).json({ error: "forbidden" });

  const ct = req.get("Content-Type") || "";
  if (!ct.includes("application/json")) {
    return res.status(400).json({ error: "invalid content-type" });
  }

  // --- Parse payload ---
  const { jobId } = req.body || {};
  if (!jobId || typeof jobId !== "string") {
    return res.status(400).json({ error: "jobId is required" });
  }

  // --- Fetch notification job doc ---
  const jobRef = db.collection("notificationJobs").doc(jobId);
  const snap = await jobRef.get();
  if (!snap.exists) {
    return res.status(200).json({ ok: true, skipped: "job_not_found" });
  }
  const job = snap.data() as NotificationJobDoc & {
    sentOnce?: boolean; // re-send guard
    lastSentAt?: FirebaseFirestore.Timestamp;
  };

  // --- Abort if retry limit reached ---
  if (attempt > MAX_ATTEMPTS) {
    const finishedAt = Timestamp.now();
    const durationMs = Number((process.hrtime.bigint() - startHr) / 1_000_000n);

    const deliveryRef = await db.collection("notificationDeliveries").add({
      jobId,
      type: job.type,
      channel: job.channel,
      targets: job.targets || {},
      status: "failure",
      attempt,
      errorMessage: `max_attempts_reached(${MAX_ATTEMPTS})`,
      responseCode: 200,
      startedAt,
      finishedAt,
      durationMs,
      source: job.source,
      createdAt: finishedAt,
    } as Omit<NotificationDeliveryDoc, "deliveryId">);
    await deliveryRef.update({ deliveryId: deliveryRef.id });

    await jobRef.delete();
    return res.status(200).json({ ok: true, skipped: "max_attempts_reached" });
  }

  // --- Validate channel & targets ---
  if (job.channel !== "slack" || !job.targets?.slack?.length) {
    const finishedAt = Timestamp.now();
    const durationMs = Number((process.hrtime.bigint() - startHr) / 1_000_000n);

    const deliveryRef = await db.collection("notificationDeliveries").add({
      jobId,
      type: job.type,
      channel: job.channel,
      targets: job.targets || {},
      status: "failure",
      attempt,
      errorMessage: "invalid_channel_or_targets",
      responseCode: 200,
      startedAt,
      finishedAt,
      durationMs,
      source: job.source,
      createdAt: finishedAt,
    } as Omit<NotificationDeliveryDoc, "deliveryId">);
    await deliveryRef.update({ deliveryId: deliveryRef.id });

    await jobRef.delete();
    return res
      .status(200)
      .json({ ok: true, skipped: "invalid_channel_or_targets" });
  }

  // --- Re-send guard: skip if already sent once ---
  if (job.sentOnce) {
    const finishedAt = Timestamp.now();
    const durationMs = Number((process.hrtime.bigint() - startHr) / 1_000_000n);

    const deliveryRef = await db.collection("notificationDeliveries").add({
      jobId,
      type: job.type,
      channel: job.channel,
      targets: job.targets,
      status: "success", // treat as success since already delivered
      attempt,
      responseCode: 200,
      startedAt,
      finishedAt,
      durationMs,
      source: job.source,
      createdAt: finishedAt,
    } as Omit<NotificationDeliveryDoc, "deliveryId">);
    await deliveryRef.update({ deliveryId: deliveryRef.id });

    await jobRef.delete();
    return res.status(200).json({ ok: true, skipped: "already_sentOnce" });
  }

  // --- Build Slack message text ---
  const p = (job.payload || {}) as Record<string, any>;
  const caption = p.caption || "";
  const chatTitle = p.chatTitle || "(no chat title)";
  const fileName = p.file?.fileName || "(no file)";

  const createdAt = job.createdAt?.toDate
    ? job.createdAt
      .toDate()
      .toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + " JST"
    : "(no timestamp)";

  const mentions = job.targets.slack!.map((t) => `<@${t.userId}>`).join(" ");

  const text = `${mentions}
It's been 3 days since you sent the proposal document in *"${chatTitle}"*.
• Document: *${fileName}*
${caption ? `• Caption: *${caption}*` : ""}
• Sent at: *${createdAt}*
Please follow up when you have a moment.`;

  // --- Ensure Slack webhook URL exists ---
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    const finishedAt = Timestamp.now();
    const durationMs = Number((process.hrtime.bigint() - startHr) / 1_000_000n);

    const deliveryRef = await db.collection("notificationDeliveries").add({
      jobId,
      type: job.type,
      channel: job.channel,
      targets: job.targets,
      status: "failure",
      attempt,
      errorMessage: "SLACK_WEBHOOK_URL is not set",
      responseCode: 500,
      startedAt,
      finishedAt,
      durationMs,
      source: job.source,
      createdAt: finishedAt,
    } as Omit<NotificationDeliveryDoc, "deliveryId">);
    await deliveryRef.update({ deliveryId: deliveryRef.id });

    return res.status(500).json({ error: "SLACK_WEBHOOK_URL is not set" });
  }

  // --- Send to Slack ---
  let respStatus = 0;
  let respText = "";
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mrkdwn: true, link_names: 1 }),
    });
    respStatus = resp.status;
    respText = await resp.text();

    // Mark job as sent (for re-send guard)
    await jobRef.update({
      sentOnce: true,
      lastSentAt: Timestamp.now(),
    });

    const finishedAt = Timestamp.now();
    const durationMs = Number((process.hrtime.bigint() - startHr) / 1_000_000n);

    // Classify error type (retryable vs non-retryable)
    const isRetryable =
      respStatus === 429 || (respStatus >= 500 && respStatus <= 599);
    const ok = resp.ok;

    const deliveryRef = await db.collection("notificationDeliveries").add({
      jobId,
      type: job.type,
      channel: job.channel,
      targets: job.targets,
      status: ok ? "success" : "failure",
      attempt,
      ...(ok
        ? {}
        : { errorMessage: respText?.slice(0, 500) || `HTTP ${respStatus}` }),
      responseCode: respStatus,
      startedAt,
      finishedAt,
      durationMs,
      source: job.source,
      createdAt: finishedAt,
    } as Omit<NotificationDeliveryDoc, "deliveryId">);
    await deliveryRef.update({ deliveryId: deliveryRef.id });

    if (!ok) {
      if (isRetryable) {
        return res
          .status(500)
          .json({ error: "slack_webhook_retryable", status: respStatus });
      } else {
        await jobRef.delete();
        return res.status(200).json({
          ok: true,
          skipped: "non_retryable_slack_error",
          status: respStatus,
        });
      }
    }

    // --- Success: delete job ---
    await jobRef.delete();
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    const finishedAt = Timestamp.now();
    const durationMs = Number((process.hrtime.bigint() - startHr) / 1_000_000n);

    const deliveryRef = await db.collection("notificationDeliveries").add({
      jobId,
      type: job.type,
      channel: job.channel,
      targets: job.targets,
      status: "failure",
      attempt,
      errorMessage: (e?.message || String(e)).slice(0, 500),
      responseCode: respStatus || 0,
      startedAt,
      finishedAt,
      durationMs,
      source: job.source,
      createdAt: finishedAt,
    } as Omit<NotificationDeliveryDoc, "deliveryId">);
    await deliveryRef.update({ deliveryId: deliveryRef.id });

    return res.status(500).json({ error: "slack_webhook_exception" });
  }
});

// -----------------------------------------------------------------------------
// POST /tasks/weekly-report
// -----------------------------------------------------------------------------
// Handler for the scheduled weekly report job (triggered by Cloud Scheduler).
//
// Flow:
// 1) (Optional) Authenticate the caller (OIDC or X-App-Task-Token).
// 2) Load active report settings: reports_settings where enabled == true.
// 3) For each setting (per chat/team/user):
//    3.1 Build AI request payload (fetches recent messages internally)
//    3.2 Call Vertex AI (Gemini) to produce a structured summary
//    3.3 Persist the result under tg_chats/{chatId}/reports/{autoId}
//    3.4 Send a formatted message to Slack
//    3.5 Update execution status on the setting document (success/error)
// 4) Return HTTP 200 with a short result payload; on fatal error return 500.
//
// Notes:
// - Authentication: Prefer Cloud Run IAM + OIDC from Scheduler; otherwise use a
//   shared header token (X-App-Task-Token) checked against an env var.
// - Idempotency: This simple version does not lock; schedule cadence should avoid overlap.
// - Config: Time window / model / prompt are code/ENV driven, not stored per setting.
// -----------------------------------------------------------------------------

app.post("/tasks/weekly-report", async (_req, res) => {
  try {
    // --- (1) Optional auth guard (uncomment if you use a header token) ---
    // const expected = (process.env.APP_TASK_TOKEN || "").trim();
    // const got = (req.get("X-App-Task-Token") || "").trim();
    // if (expected && got !== expected) return res.status(403).json({ error: "forbidden" });

    // --- (2) Kick off the orchestrator ---
    // Orchestrates:
    //  - Load settings
    //  - For each target: build payload → summarize → save → Slack → update status
    await runWeeklyReport();

    // --- (3) Respond success quickly (Scheduler expects a short 2xx) ---
    return res.status(200).json({ ok: true });
  } catch (e) {
    // --- (4) On unexpected failures, log and return 5xx so the caller can retry ---
    console.error("[/tasks/weekly-report] error:", e);
    return res.status(500).json({ ok: false, error: "weekly_report_failed" });
  }
});

// -----------------------------------------------------------------------------
// HTTP server bootstrap
// - Binds to PORT env var (fallback: 8080)
// - Logs startup and startup errors
// - (Optional) graceful shutdown hooks
// -----------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 8080);

// Start server
const server = app.listen(port, () => {
  console.log(`[server] Listening on :${port}`);
});

// Handle startup errors early (e.g., EADDRINUSE)
server.on("error", (err) => {
  console.error("[server] Failed to start:", err);
  process.exit(1);
});

// (Optional) Graceful shutdown — safe to keep or remove without changing behavior
process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, shutting down gracefully…");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("[server] SIGINT received, shutting down gracefully…");
  server.close(() => process.exit(0));
});
