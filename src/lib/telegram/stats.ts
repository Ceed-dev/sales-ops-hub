import {
  Timestamp,
  FieldValue,
  DocumentReference,
} from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { toUtcDayKey } from "../../utils/time.js";
import type { ChatRoomDoc } from "../../types/chat.js";

/**
 * Checks whether the message type should be counted in statistics.
 * (e.g., exclude member join/leave events)
 */
export function isCountableMessage(type: string): boolean {
  return type !== "member_join" && type !== "member_leave";
}

/**
 * Updates chat-level statistics in Firestore.
 * - Increments counters at chat and user level
 * - Updates daily buckets
 * - Maintains uniqueSendersCount and usernames
 * - Tracks peak per day
 *
 * @param chatRef - Firestore document reference to tg_chats/{chatId}
 * @param msg - Raw Telegram message
 * @param type - Message type string
 */
export async function updateStats(
  chatRef: DocumentReference,
  msg: any,
  type: string,
): Promise<void> {
  if (!isCountableMessage(type)) return;

  const userId = String(msg.from?.id ?? "");
  const username = msg.from?.username ?? null;
  const isBot = !!msg.from?.is_bot;
  const sentAt = Timestamp.fromMillis((msg.date ?? 0) * 1000);
  const dayKey = toUtcDayKey(sentAt.toMillis());

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(chatRef);
    const data = (snap.exists ? snap.data() : {}) as ChatRoomDoc;
    const stats = data?.stats ?? {};
    const byUser = stats.byUser ?? {};
    const daily = stats.daily ?? {};

    const prevUser = byUser[userId] as any | undefined;
    const userExists = !!prevUser;

    const prevTodayCount = daily[dayKey]?.messageCount ?? 0;
    const nextTodayCount = prevTodayCount + 1;
    const prevPeak = stats.aggregated?.peakPerDay?.count ?? 0;

    // --- Nested object updates (merge:true, no dot-notation) ---
    const nestedUpdates: Record<string, any> = {
      stats: {
        messageCount: FieldValue.increment(1),
        totalMessages: FieldValue.increment(1),
        daily: {
          [dayKey]: {
            messageCount: FieldValue.increment(1),
          },
        },
        byUser: {
          [userId]: {
            messageCount: FieldValue.increment(1),
            lastMessageAt: sentAt,
          },
        },
      },
    };

    // First-time user updates
    if (!userExists) {
      nestedUpdates.stats.uniqueSendersCount = FieldValue.increment(1);
      nestedUpdates.stats.byUser[userId].firstMessageAt = sentAt;
      nestedUpdates.stats.byUser[userId].isBot = isBot;
    }

    // Username updates (only when changed)
    const prevUsername = (prevUser?.username ?? null) as string | null;
    if (username && username !== prevUsername) {
      nestedUpdates.stats.byUser[userId].username = username;
    }

    // Update daily peak
    if (nextTodayCount > prevPeak) {
      nestedUpdates.stats.aggregated = {
        ...(stats.aggregated ?? {}),
        peakPerDay: { date: dayKey, count: nextTodayCount },
      };
    }

    tx.set(chatRef, nestedUpdates, { merge: true });
  });
}
