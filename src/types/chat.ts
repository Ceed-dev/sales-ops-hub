// Firestore document: tg_chats/{chatId}
// All IDs stored as string (Telegram uses 64-bit; string avoids precision issues).
// All dates/times are Firestore Timestamp in UTC.

import { Timestamp } from "firebase-admin/firestore";
import type { MessageType } from "./message.js";

export type ChatStatus = "active" | "archived";
export type ChatTag = "Defi" | "Japan" | "Game" | "NFT" | "Other";
export type ChatType = "private" | "group" | "supergroup" | "channel" | string;

interface AggregatedPeriod {
  // Pre-computed totals for a rolling window (e.g., last 7/30/90 days).
  messageCount: number; // Sum of daily.messageCount within the window
  avgPerDay: number; // messageCount / windowDays (zeros included)
}

interface PeakPerDay {
  // The most active single day in the considered horizon (e.g., last 90d).
  date: string; // "YYYY-MM-DD" (UTC)
  count: number;
}

interface LatestMessage {
  // Lightweight cache for list screens; full payload lives in messages/* docs.
  messageId: string;
  fromUserId: string;
  fromUsername: string | null;
  isBot: boolean;
  type: MessageType;
  sentAt: Timestamp; // UTC

  /**
   * One-line preview of the message content, derived from type:
   * - text        → first 100 chars of message.text
   * - photo       → caption if present, otherwise "📷 Photo"
   * - video       → caption if present, otherwise "🎥 Video"
   * - document    → caption if present, otherwise file_name (e.g. "📄 sample.pdf")
   * - sticker     → emoji if present, otherwise "👍 Sticker"
   * - member_join → "👤 @username joined"
   * - member_leave→ "👋 @username left"
   * - other       → "[other]"
   */
  summary: string;
}

export interface Aggregated {
  last7Days: AggregatedPeriod;
  last30Days: AggregatedPeriod;
  last90Days: AggregatedPeriod;
  peakPerDay: PeakPerDay;
}

interface ByUserEntry {
  // Per-user stats within THIS chat room (for rankings, activity).
  username: string | null; // Telegram @username at last seen time
  isBot: boolean; // True if the user is a bot
  messageCount: number; // Cumulative messages by this user in this chat
  firstMessageAt: Timestamp; // First message time in this chat (UTC)
  lastMessageAt: Timestamp; // Most recent message time (UTC)
  aggregated: Aggregated; // Period aggregates for this user
}

export interface ChatStats {
  // Counters & analytics for the chat room.
  messageCount: number; // Currently retained messages in Firestore (post-TTL)
  totalMessages: number; // All-time count (does not decrease with TTL)
  uniqueSendersCount: number; // Number of distinct senders ever seen in this chat

  // Daily buckets keyed by UTC date. Create key only when >0 to avoid sparse data.
  daily: {
    [yyyy_mm_dd: string]: { messageCount: number };
  };

  aggregated: Aggregated;

  // Map keyed by userId (string). Be mindful of doc size; shard to subcollection
  // if the user count grows large.
  byUser: {
    [userId: string]: ByUserEntry;
  };
}

export interface ChatRoomDoc {
  // --- Basics ---
  chatId: string; // Telegram chat.id as string (may be negative)
  chatType: ChatType; // "group" | "supergroup" | "channel" | ...
  title: string; // Chat display name
  tags: ChatTag[]; // Optional classification labels (e.g., ["Defi", "Japan"])

  // --- Lifecycle / state ---
  status: ChatStatus; // "active" while bot is in the chat; "archived" when removed
  botActivityHistory: Array<{
    status: ChatStatus; // State after the event
    ts: Timestamp; // Event time (UTC)
    reason: string; // e.g., "bot_joined" | "bot_removed"
  }>;

  // --- Latest message cache ---
  latestMessage: LatestMessage;
  lastActiveAt: Timestamp; // Mirror of latestMessage.sentAt for sorting

  // --- Analytics ---
  stats: ChatStats;
}
