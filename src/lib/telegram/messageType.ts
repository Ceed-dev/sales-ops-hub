// -----------------------------------------------------------------------------
// Telegram message type detection utilities
// - Provides MessageType enum and detectMessageType() function
// -----------------------------------------------------------------------------

import type { MessageType } from "../../types/message.js";

/**
 * Detects the MessageType from a Telegram `message` object.
 * Reference: https://core.telegram.org/bots/api#message
 *
 * Order of checks:
 * 1. Membership events (join/leave)
 * 2. Content types (text, photo, video, document, sticker)
 * 3. Fallback → "other"
 *
 * @param message - Telegram message object
 * @returns MessageType
 */
export function detectMessageType(message: any): MessageType {
  if (!message || typeof message !== "object") return "other";

  // --- Membership events ---
  if (
    Array.isArray(message.new_chat_members) &&
    message.new_chat_members.length > 0
  ) {
    return "member_join";
  }
  if (message.left_chat_member) {
    return "member_leave";
  }

  // --- Content types ---
  if (typeof message.text === "string" && message.text.length > 0)
    return "text";
  if (Array.isArray(message.photo) && message.photo.length > 0) return "photo";
  if (message.video) return "video";
  if (message.document) return "document";
  if (message.sticker) return "sticker";

  // --- Fallback ---
  return "other";
}
