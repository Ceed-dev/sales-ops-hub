// Firestore document: tg_chats/{chatId}/messages/{messageId}
// One doc per Telegram message. Full raw JSON stored for fallback.

import { Timestamp } from "firebase-admin/firestore";

export type MessageType =
  | "text"
  | "photo"
  | "video"
  | "document"
  | "sticker"
  | "member_join"
  | "member_leave"
  | "other";

export interface MessageDoc {
  // --- Core identifiers ---
  chatId: string; // Telegram chat.id (stringified, may be negative for groups)
  messageId: string; // Telegram message_id; also used as Firestore doc ID
  updateId: number; // Telegram update_id (mainly for debugging/order tracing)

  // --- Sender info ---
  fromUserId: string; // Telegram user.id (stringified)
  fromUsername: string | null; // @username if available, otherwise null
  isBot: boolean; // Whether the sender is a bot

  // --- Type & content ---
  type: MessageType; // Derived from which key exists in raw (text/photo/etc.)
  sentAt: Timestamp; // Telegram's message.date (UTC)
  expireAt: Timestamp; // TTL auto-delete (e.g. sentAt + 30d)

  // --- Raw payload ---
  raw: Record<string, any>; // Full JSON from Telegram webhook; guarantees future-proofing
}
