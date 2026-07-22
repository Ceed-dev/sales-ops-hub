import type { Timestamp } from "firebase-admin/firestore";

export type EmailTrackingEventType = "open" | "click";

export type EmailTrackingClientCategory =
  | "google_image_proxy"
  | "outlook_proxy"
  | "automated_scanner"
  | "unknown";

export interface EmailTrackingRecipientDoc {
  campaignId: string;
  recipientId: string;
  registrationFingerprint: string;
  destinationUrl: string;
  industry?: string;
  subjectVariant?: string;
  bodyVariant?: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  sentAt?: Timestamp;
  firstOpenedAt?: Timestamp;
  lastOpenedAt?: Timestamp;
  openCount: number;
  scannerOpenCount: number;
  firstClickedAt?: Timestamp;
  lastClickedAt?: Timestamp;
  clickCount: number;
  scannerClickCount: number;
}

export interface EmailTrackingEventDoc {
  tokenHash: string;
  campaignId: string;
  eventType: EmailTrackingEventType;
  occurredAt: Timestamp;
  expiresAt: Timestamp;
  clientCategory: EmailTrackingClientCategory;
  isLikelyAutomated: boolean;
}

export interface CreateEmailTrackingRecipientInput {
  campaignId: string;
  idempotencyKey: string;
  destinationUrl: string;
  industry?: string;
  subjectVariant?: string;
  bodyVariant?: string;
  sentAt: string;
}
