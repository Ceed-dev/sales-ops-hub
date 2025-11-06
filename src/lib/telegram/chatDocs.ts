// -----------------------------------------------------------------------------
// Firestore document builders for tg_chats/{chatId}
// - Provides helpers for creating new chat docs and partial updates
// -----------------------------------------------------------------------------

import { Timestamp } from "firebase-admin/firestore";
import type { ChatRoomDoc, ChatStatus, ChatStats } from "../../types/chat.js";
import type { MessageType } from "../../types/message.js";

/**
 * Returns the initial stats object for a newly created chat.
 */
export function defaultChatStats(): ChatStats {
  return {
    messageCount: 0,
    totalMessages: 0,
    uniqueSendersCount: 0,
    daily: {},
    aggregated: {
      last7Days: { messageCount: 0, avgPerDay: 0 },
      last30Days: { messageCount: 0, avgPerDay: 0 },
      last90Days: { messageCount: 0, avgPerDay: 0 },
      peakPerDay: { date: "", count: 0 },
    },
    byUser: {},
  };
}

/**
 * Builds a new ChatRoomDoc object for initial creation.
 */
export function buildNewChatRoomDoc(params: {
  msg: any;
  type: MessageType;
  summary: string;
  sentAt: Timestamp;
  botActivityHistoryEntry: {
    status: ChatStatus;
    ts: Timestamp;
    reason: string;
  } | null;
}): ChatRoomDoc {
  const { msg, type, summary, sentAt, botActivityHistoryEntry } = params;
  return {
    chatId: msg.chat.id.toString(),
    chatType: msg.chat.type,
    title: msg.chat.title ?? "",
    tags: [],
    status: botActivityHistoryEntry?.status ?? "active",
    phase: {
      value: "BotAdded",
      ts: sentAt,
      messageId: String(msg.message_id),
    },
    botActivityHistory: botActivityHistoryEntry
      ? [botActivityHistoryEntry]
      : [],
    latestMessage: {
      messageId: String(msg.message_id),
      fromUserId: String(msg.from.id),
      fromUsername: msg.from.username ?? null,
      isBot: !!msg.from.is_bot,
      type,
      sentAt,
      summary,
    },
    lastActiveAt: sentAt,
    stats: defaultChatStats(),
    latestReportId: null,
  };
}

/**
 * Builds a partial update object for updating an existing chat doc.
 */
export function buildChatPartialUpdate(params: {
  msg: any;
  type: MessageType;
  summary: string;
  sentAt: Timestamp;
  botActivityHistoryEntry: {
    status: ChatStatus;
    ts: Timestamp;
    reason: string;
  } | null;
}): Partial<ChatRoomDoc> {
  const { msg, type, summary, sentAt, botActivityHistoryEntry } = params;
  const update: Partial<ChatRoomDoc> = {
    chatId: msg.chat.id.toString(),
    chatType: msg.chat.type,
    title: msg.chat.title ?? "",
    latestMessage: {
      messageId: String(msg.message_id),
      fromUserId: String(msg.from.id),
      fromUsername: msg.from.username ?? null,
      isBot: !!msg.from.is_bot,
      type,
      sentAt,
      summary,
    },
    lastActiveAt: sentAt,
  };

  if (botActivityHistoryEntry) {
    update.status = botActivityHistoryEntry.status;
    // arrayUnion is used on save; here we just declare the intent
    update.botActivityHistory = [botActivityHistoryEntry];
  }

  return update;
}
