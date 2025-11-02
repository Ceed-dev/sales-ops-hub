// Firestore document: notificationJobs/{jobId}
// - jobId is a deterministic or random UUID (idempotent key recommended: e.g. hash of sourceId+type).
// - Each document represents one scheduled notification job (pending execution).
// - This collection only keeps "to-do notifications".
// - Once executed, the job doc is deleted, and a delivery record is created in notificationDeliveries/*.
// - Timestamps are Firestore Timestamp (UTC).

import { Timestamp } from "firebase-admin/firestore";

// -----------------------------------------------------------------------------
// Core types
// -----------------------------------------------------------------------------

// Supported notification types
export type NotificationType =
  | "follow_up_bot_join_call_check"
  | "follow_up_proposal_1st"
  | "follow_up_proposal_2nd"
  | "follow_up_invoice_1st"
  | "follow_up_invoice_2nd"
  | "follow_up_calendly"
  | "follow_up_agreement_1st"
  | "follow_up_agreement_2nd";

// Job is always "pending" until executed, then deleted.
export type JobStatus = "pending";

// Supported channels
export type NotificationChannel = "slack" | "email" | "tg";

// Target definitions per channel
interface SlackTarget {
  teamId: string; // "Txxxxxx" (workspace)
  userId: string; // "Uxxxxxx" (<@Uxxxxxx> mention target)
}

interface EmailTarget {
  to: string; // recipient email address
}

interface TelegramTarget {
  chatId: string; // TG chat or user ID
}

// -----------------------------------------------------------------------------
// Main Document
// -----------------------------------------------------------------------------
export interface NotificationJobDoc {
  // --- Identity ---
  jobId: string; // doc id (UUID or deterministic hash)
  type: NotificationType; // use-case identifier (enum of follow-up notification types)
  channel: NotificationChannel; // main channel to send

  // --- Scheduling ---
  scheduledAt: Timestamp; // ETA execution time (UTC; e.g. 3rd day 15:00 JST converted)
  status: JobStatus; // always "pending"

  // --- Targets ---
  targets: {
    slack?: SlackTarget[]; // allow multiple mentions
    email?: EmailTarget[];
    tg?: TelegramTarget[];
  };

  // --- Template / Payload ---
  templateId?: string; // notification template (optional if fixed text)
  payload?: Record<string, unknown>; // dynamic fields for template substitution

  // --- Provenance ---
  source: { kind: string; id: string }; // origin of this job (e.g. {kind:"message", id:"12345"})

  // --- Audit ---
  createdAt: Timestamp; // job creation time
}

// Firestore document: notificationDeliveries/{deliveryId}
// - deliveryId can be auto-generated (unique per delivery attempt).
// - Each document represents one completed delivery attempt (success or failure).
// - Jobs are deleted from notificationJobs after execution; this collection is the permanent log.
// - Timestamps are Firestore Timestamp (UTC).

// -----------------------------------------------------------------------------
// Core types
// -----------------------------------------------------------------------------

export type DeliveryStatus = "success" | "failure";

// -----------------------------------------------------------------------------
// Main Document
// -----------------------------------------------------------------------------
export interface NotificationDeliveryDoc {
  // --- Identity ---
  deliveryId: string; // doc id (auto-generated is fine)
  jobId: string; // reference back to the job (deleted after execution)
  type: NotificationType; // use-case identifier (enum of follow-up notification types)
  channel: NotificationChannel; // channel used

  // --- Target(s) ---
  targets: {
    slack?: SlackTarget[];
    email?: EmailTarget[];
    tg?: TelegramTarget[];
  };

  // --- Result ---
  status: DeliveryStatus; // success or failure
  attempt: number; // 1 for first attempt, 2 for retry, etc.
  errorMessage?: string; // failure details (truncated if long)
  responseCode?: number; // e.g. HTTP 200, 400, 500

  // --- Timing ---
  startedAt: Timestamp; // when attempt started
  finishedAt: Timestamp; // when attempt finished
  durationMs: number; // processing time

  // --- Provenance ---
  source: { kind: string; id: string }; // original origin (copied from job.source)

  // --- Audit ---
  createdAt: Timestamp; // record creation time
}
