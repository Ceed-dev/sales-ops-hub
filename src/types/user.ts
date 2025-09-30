// Firestore document: tg_users/{userId}
// - All IDs are stored as strings (Telegram uses 64-bit; strings avoid precision issues).
// - All dates/times use Firestore Timestamp in UTC.

import { Timestamp, DocumentReference } from "firebase-admin/firestore";

import type { Aggregated } from "./chat.js";
import type { MessageType } from "./message.js";

// -----------------------------------------------------------------------------
// Lightweight cache of the user's latest activity across ALL chats
// -----------------------------------------------------------------------------
interface LatestUserActivity {
  // Identifiers (SoT = chatId + messageId as strings)
  messageId: string; // tg_chats/{chatId}/messages/{messageId} → last segment only
  chatId: string; // tg_chats/{chatId} (string as Source of Truth)

  // Snapshots for fast list rendering without extra reads
  chatTitle: string; // Chat title at last seen time (snapshot)
  type: MessageType; // Message type of the latest activity
  sentAt: Timestamp; // UTC
  summary: string; // One-line preview (same rule as LatestMessage)

  // Convenience reference to the specific message document (direct fetch).
  messageRef: DocumentReference;
}

// -----------------------------------------------------------------------------
// Main Document
// -----------------------------------------------------------------------------
export interface TelegramUserDoc {
  // --- Identity snapshot ---
  userId: string; // Telegram user.id as string
  isBot: boolean; // True if the user is a bot
  username: string | null; // "@username" without "@", nullable
  firstName: string; // First name at last seen time
  lastName: string | null; // Last name at last seen time (nullable)

  // --- Lifecycle ---
  createdAt: Timestamp; // First time we saw this user (any chat)
  lastSeenAt: Timestamp; // Last message time across ALL chats

  // --- Participation ---
  linkedChatIds: string[]; // Unique chat IDs where this user appeared (use arrayUnion)
  distinctChats: number; // Mirror counter for fast sorting (length of linkedChatIds)

  // --- Counters ---
  counters: {
    totalMessages: number; // All-time message count across ALL chats (never decreases)
  };

  // --- Daily & aggregates (GLOBAL) ---
  daily: {
    // Create a key only when > 0 to avoid sparse data.
    [yyyy_mm_dd: string]: { messageCount: number };
  };
  aggregated: Aggregated;

  // --- Latest activity cache ---
  latestActivity: LatestUserActivity | null; // Null if no activity observed yet
}
