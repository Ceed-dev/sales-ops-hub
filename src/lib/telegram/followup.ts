// -----------------------------------------------------------------------------
// Proposal follow-up: detect "document + caption includes 'proposal'",
// create notificationJobs entry, and enqueue Cloud Tasks for Slack reminder.
// -----------------------------------------------------------------------------

import { Timestamp, DocumentReference } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { jst1500On3rdDay } from "../../utils/time.js";
import { hashId } from "../../utils/hash.js";
import { isFromInternal } from "../isInternal.js";
import { enqueueHttpEtaTask } from "../cloudTasks.js";
import type { MessageType } from "../../types/message.js";
import type { NotificationJobDoc } from "../../types/notification.js";

/** Returns true when the message is a document whose caption contains "proposal"
 *  AND it was sent by an internal member.
 */
export function shouldCreateProposalFollowup(
  msg: any,
  type: MessageType,
): boolean {
  if (type !== "document") return false;
  if (!isFromInternal(msg?.from?.id)) return false;
  const cap = String(msg?.caption ?? "").toLowerCase();
  return cap.includes("proposal");
}

/**
 * Creates a notification job (notificationJobs/{jobId}) and schedules a Cloud Task
 * to POST /tasks/notifications at the ETA (15:00 JST on the 3rd day after sentAt).
 * - Idempotent via deterministic jobId.
 */
export async function handleProposalFollowup(params: {
  msg: any;
  type: MessageType;
  sentAt: Timestamp;
  chatRef: DocumentReference;
  msgRef: DocumentReference;
}): Promise<void> {
  const { msg, type, sentAt, chatRef, msgRef } = params;

  if (!shouldCreateProposalFollowup(msg, type)) return;

  const chatId = String(msg.chat.id);
  const messageId = String(msg.message_id);
  const caption = String(msg.caption ?? "");
  const chatTitle = msg.chat.title ?? "";

  // Optional file info (document only)
  const fileInfo = msg?.document
    ? {
      fileId: msg.document.file_id ?? null,
      fileName: msg.document.file_name ?? null,
      mimeType: msg.document.mime_type ?? null,
      fileSize: msg.document.file_size ?? null,
    }
    : null;

  // ETA: 3rd day 15:00 JST (as UTC Timestamp)
  const scheduledAt = jst1500On3rdDay(sentAt.toDate());

  // Idempotent job id
  const jobId = hashId(`job:follow_up_proposal:${chatId}:${messageId}`);
  const jobRef = db.collection("notificationJobs").doc(jobId);

  const jobSnap = await jobRef.get();
  if (jobSnap.exists) {
    console.log("[followup] job already exists, skip:", jobId);
    return;
  }

  // Lookup Slack targets from people/{personId} by telegram.userId
  let slackTargets: Array<{ teamId: string; userId: string }> = [];
  const tgUserId = String(msg.from?.id ?? "");
  if (tgUserId) {
    const peopleSnap = await db
      .collection("people")
      .where("telegram.userId", "==", tgUserId)
      .limit(1)
      .get();

    if (!peopleSnap.empty) {
      const personDoc = peopleSnap.docs[0]!.data();
      slackTargets = (personDoc.slack ?? []).map((s: any) => ({
        teamId: s.teamId,
        userId: s.userId,
      }));
    }
  }

  const jobDoc: NotificationJobDoc = {
    // Identity
    jobId,
    type: "follow_up_proposal",
    channel: "slack",

    // Scheduling
    scheduledAt,
    status: "pending",

    // Targets
    targets: { slack: slackTargets },

    // Template / Payload
    payload: {
      chatId,
      messageId,
      chatTitle,
      caption,
      file: fileInfo,
      fromUser: {
        userId: String(msg.from?.id ?? ""),
        username: msg.from?.username ?? null,
        isBot: !!msg.from?.is_bot,
      },
      chatRefPath: chatRef.path,
      messageRefPath: msgRef.path,
    },

    // Provenance
    source: { kind: "message", id: messageId },

    // Audit
    createdAt: Timestamp.now(),
  };

  await jobRef.set(jobDoc, { merge: false });

  // Enqueue Cloud Task (HTTP target)
  await enqueueHttpEtaTask({
    url: `${process.env.PUBLIC_BASE_URL}/tasks/notifications`,
    payload: { jobId },
    scheduledAt,
  });

  console.log("[followup] job scheduled at:", scheduledAt.toDate(), jobId);
}
