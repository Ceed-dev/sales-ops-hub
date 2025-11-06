// -----------------------------------------------------------------------------
// Proposal follow-up: detect "document + caption includes 'proposal'",
// create notificationJobs entry, and enqueue Cloud Tasks for Slack reminder.
// -----------------------------------------------------------------------------

import { Timestamp, DocumentReference } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { scheduleAtJST } from "../../utils/time.js";
import { hashId } from "../../utils/hash.js";
import { isFromInternal } from "../isInternal.js";
import { enqueueHttpEtaTask } from "../cloudTasks.js";
import type { MessageType } from "../../types/message.js";
import type {
  NotificationType,
  NotificationJobDoc,
} from "../../types/notification.js";
import { PHASE_BY_NOTIF } from "../../types/chat.js";
import { upsertChatPhaseIfAdvanced } from "./updateChatPhase.js";

/**
 * Build one or more follow-up schedules for a detected notification type.
 * - Always returns concrete (type, scheduledAt) pairs.
 * - Defaults: business days, 15:00 JST (via scheduleAtJST).
 * - bot_join_call_check → +3h (JST); if falls between 03:00–11:00 JST (inclusive), snap to 11:00 JST.
 */
function getFollowupSchedules(
  notifType: NotificationType,
  sentAt: Date,
): Array<{ type: NotificationType; scheduledAt: Timestamp }> {
  const mk = (type: NotificationType, days: number) => ({
    type,
    scheduledAt: scheduleAtJST(sentAt, { days }), // 15:00 JST, businessDays: true
  });

  // --- Special scheduling for bot-join call check (no business day logic) ---
  if (notifType === "follow_up_bot_join_call_check") {
    // +3 hours from the join time (UTC basis)
    const plus3 = new Date(sentAt.getTime() + 3 * 3600_000);

    // Convert to JST components by shifting +9h from UTC
    const jst = new Date(plus3.getTime() + 9 * 3600_000);
    const y = jst.getUTCFullYear();
    const m = jst.getUTCMonth();
    const d = jst.getUTCDate();
    const h = jst.getUTCHours(); // JST hour

    // If 03:00–11:00 JST (inclusive), snap to 11:00 JST same day
    const scheduledJst =
      h >= 3 && h <= 11 ? new Date(Date.UTC(y, m, d, 2)) /* 11:00 JST */ : jst;

    // Convert back to UTC Date for Firestore Timestamp (subtract 9h)
    const scheduledUtc = new Date(scheduledJst.getTime() - 9 * 3600_000);

    return [
      {
        type: "follow_up_bot_join_call_check",
        scheduledAt: Timestamp.fromDate(scheduledUtc),
      },
    ];
  }

  switch (notifType) {
    // Proposal: 1st (+3d), 2nd (+6d)
    case "follow_up_proposal_1st":
      return [mk("follow_up_proposal_1st", 3), mk("follow_up_proposal_2nd", 6)];
    case "follow_up_proposal_2nd":
      return [mk("follow_up_proposal_2nd", 6)];

    // Invoice: 1st (+2d), 2nd (+4d)
    case "follow_up_invoice_1st":
      return [mk("follow_up_invoice_1st", 2), mk("follow_up_invoice_2nd", 4)];
    case "follow_up_invoice_2nd":
      return [mk("follow_up_invoice_2nd", 4)];

    // Calendly: once (+1d)
    case "follow_up_calendly":
      return [mk("follow_up_calendly", 1)];

    // Agreement: 1st (+2d), 2nd (+4d)
    case "follow_up_agreement_1st":
      return [
        mk("follow_up_agreement_1st", 2),
        mk("follow_up_agreement_2nd", 4),
      ];
    case "follow_up_agreement_2nd":
      return [mk("follow_up_agreement_2nd", 4)];

    default:
      return [];
  }
}

/** Decide a single follow-up type for this message.
 *  Returns null if none matches.
 *  Priority: bot_join_call_check → proposal → invoice → calendly → agreement
 */
function getFollowupType(msg: any, type: MessageType): NotificationType | null {
  // Guard: only messages from internal members are eligible
  if (!isFromInternal(msg?.from?.id)) return null;

  // --- Helpers ---------------------------------------------------------------
  const caption = String(msg?.caption ?? "");
  const text = String(msg?.text ?? "");
  const fileName = String(msg?.document?.file_name ?? "");
  const combined = `${caption}\n${text}\n${fileName}`.toLowerCase();

  const has = (kw: string) => combined.includes(kw);
  const hasAny = (kws: string[]) => kws.some((k) => combined.includes(k));

  // Detect "bot was added to the group" event (member_join includes the bot itself)
  const BOT_USERNAME = "sales_ops_assistant_bot";
  const isBotJoinCallCheck =
    type === "member_join" &&
    Array.isArray(msg?.new_chat_members) &&
    msg.new_chat_members.some((u: any) => u.username === BOT_USERNAME);

  // Link-based matchers
  const isProposalDoc =
    hasAny(["docs.google.com", "drive.google.com"]) && has("proposal");
  const isInvoiceDoc = type === "document" && has("invoice");
  const isCalendly = has("calendly.com");
  const isAgreement =
    hasAny(["docs.google.com", "drive.google.com"]) && has("agreement");

  // --- Priority order --------------------------------------------------------
  // 1) When the bot is first added, schedule a "call link sent?" reminder (3h later).
  if (isBotJoinCallCheck) return "follow_up_bot_join_call_check";

  // 2) Content-based follow-ups
  if (isProposalDoc) return "follow_up_proposal_1st";
  if (isInvoiceDoc) return "follow_up_invoice_1st";
  if (isCalendly) return "follow_up_calendly";
  if (isAgreement) return "follow_up_agreement_1st";

  return null;
}

// -----------------------------------------------------------------------------
// Helper: create a single follow-up job in Firestore and enqueue a Cloud Task.
// - Idempotent via deterministic jobId (notifType + chatId + messageId)
// - Schedules HTTP POST to /tasks/notifications at `scheduledAt`
// -----------------------------------------------------------------------------
async function createJobAndTask(args: {
  notifType: NotificationType;
  scheduledAt: Timestamp;
  chatId: string;
  messageId: string;
  chatTitle: string;
  caption: string;
  fileInfo: any | null;
  chatRefPath: string;
  messageRefPath: string;
  fromUser: { userId: string; username: string | null; isBot: boolean };
  slackTargets: Array<{ teamId: string; userId: string }>;
}): Promise<void> {
  const {
    notifType,
    scheduledAt,
    chatId,
    messageId,
    chatTitle,
    caption,
    fileInfo,
    chatRefPath,
    messageRefPath,
    fromUser,
    slackTargets,
  } = args;

  // --- Build idempotent job id ---
  const jobId = hashId(`job:${notifType}:${chatId}:${messageId}`);
  const jobRef = db.collection("notificationJobs").doc(jobId);

  // --- Skip if already exists (idempotency) ---
  const jobSnap = await jobRef.get();
  if (jobSnap.exists) {
    console.log("[followup] job exists, skip:", jobId);
    return;
  }

  // --- Persist job document (pending) ---
  const jobDoc: NotificationJobDoc = {
    jobId,
    type: notifType, // use-case identifier (enum of follow-up notification types)
    channel: "slack",
    scheduledAt,
    status: "pending",
    targets: { slack: slackTargets },
    payload: {
      chatId,
      messageId,
      chatTitle,
      caption,
      file: fileInfo,
      fromUser,
      chatRefPath,
      messageRefPath,
    },
    source: { kind: "message", id: messageId },
    createdAt: Timestamp.now(),
  };
  await jobRef.set(jobDoc, { merge: false });

  // --- Enqueue Cloud Task (HTTP POST at ETA) ---
  await enqueueHttpEtaTask({
    url: `${process.env.PUBLIC_BASE_URL}/tasks/notifications`,
    payload: { jobId },
    scheduledAt,
  });

  // --- Advance chat.phase if this notif type maps to a higher phase ---
  const mappedPhase = PHASE_BY_NOTIF[notifType];
  if (mappedPhase) {
    // Monotonic/idempotent inside the helper
    await upsertChatPhaseIfAdvanced(chatId, {
      value: mappedPhase,
      ts: Timestamp.now(),
      messageId,
    });
  }

  console.log("[followup] scheduled:", notifType, scheduledAt.toDate(), jobId);
}

// -----------------------------------------------------------------------------
// Main: decide follow-up types, build schedules, and register jobs + tasks.
// - Uses getFollowupType → getFollowupSchedules → createJobAndTask
// - Creates 1 or 2 jobs depending on the base type (proposal/invoice/agreement)
// -----------------------------------------------------------------------------
export async function handleFollowupTriggers(params: {
  msg: any;
  type: MessageType;
  sentAt: Timestamp;
  chatRef: DocumentReference;
  msgRef: DocumentReference;
}): Promise<void> {
  const { msg, type, sentAt, chatRef, msgRef } = params;

  // 1) Decide base notification type (null → no-op)
  const baseType = getFollowupType(msg, type);
  if (!baseType) return;

  // 2) Expand to one or more schedules (e.g., proposal → 1st & 2nd)
  const schedules = getFollowupSchedules(baseType, sentAt.toDate());
  if (!schedules.length) return;

  // 3) Common payload parts
  const chatId = String(msg.chat.id);
  const messageId = String(msg.message_id);
  const chatTitle = msg.chat.title ?? "";
  const caption = String(msg.caption ?? "");
  const fileInfo = msg?.document
    ? {
        fileId: msg.document.file_id ?? null,
        fileName: msg.document.file_name ?? null,
        mimeType: msg.document.mime_type ?? null,
        fileSize: msg.document.file_size ?? null,
      }
    : null;

  // 4) Resolve Slack targets once
  let slackTargets: Array<{ teamId: string; userId: string }> = [];

  // NOTE: For bot-join reminder, mention ONLY specific teammates
  const INCLUDE_PERSON_IDS = [
    "0UvQYfArgM2TrluTjUEX", // Badhan
    "UDCrchwnyUdsWB6KIQgV", // Jaz
    "lDuGIr68v1OJ4hJUMZEC", // Hugo
  ];

  if (baseType === "follow_up_bot_join_call_check") {
    const allPeopleSnap = await db.collection("people").get();
    slackTargets = allPeopleSnap.docs
      // --- Include only specific people ---
      .filter((d) => INCLUDE_PERSON_IDS.includes(d.id))
      .flatMap((d) =>
        (d.data().slack ?? []).map((s: any) => ({
          teamId: s.teamId,
          userId: s.userId,
        })),
      )
      .filter((t) => t.teamId && t.userId); // sanitize
  } else {
    // default: only the sender (existing behavior)
    const tgUserId = String(msg.from?.id ?? "");
    if (tgUserId) {
      const peopleSnap = await db
        .collection("people")
        .where("telegram.userId", "==", tgUserId)
        .limit(1)
        .get();
      if (!peopleSnap.empty) {
        const personDoc = peopleSnap.docs[0]!.data();
        slackTargets = (personDoc.slack ?? [])
          .map((s: any) => ({ teamId: s.teamId, userId: s.userId }))
          .filter((t: any) => t.teamId && t.userId);
      }
    }
  }

  // 5) Create jobs for all schedules (1 or 2 items)
  for (const { type: notifType, scheduledAt } of schedules) {
    await createJobAndTask({
      notifType,
      scheduledAt,
      chatId,
      messageId,
      chatTitle,
      caption,
      fileInfo,
      chatRefPath: chatRef.path,
      messageRefPath: msgRef.path,
      fromUser: {
        userId: String(msg.from?.id ?? ""),
        username: msg.from?.username ?? null,
        isBot: !!msg.from?.is_bot,
      },
      slackTargets,
    });
  }
}
