// -----------------------------------------------------------------------------
// Telegram message summary generator
// - Provides a short, human-readable one-line preview of a message
// - Based on detected MessageType
// -----------------------------------------------------------------------------

import type { MessageType } from "../../types/message.js";

/**
 * Generates a summary string from a Telegram `message` object
 * and a detected MessageType.
 *
 * Rules:
 * - text: first 100 chars
 * - photo: caption or "📷 Photo"
 * - video: caption or "🎥 Video"
 * - document: caption or file_name (fallback)
 * - sticker: emoji or "👍 Sticker"
 * - member_join: list of joined usernames
 * - member_leave: leaving user
 * - other: "[other]"
 *
 * @param message - Telegram message object
 * @param type - Detected MessageType
 * @returns Summary string
 */
export function generateSummary(message: any, type: MessageType): string {
  if (!message) return "[other]";

  switch (type) {
    case "text": {
      const text = message.text || "";
      return text.length > 100 ? text.slice(0, 100) + "…" : text;
    }

    case "photo":
      return message.caption ? message.caption : "📷 Photo";

    case "video":
      return message.caption ? message.caption : "🎥 Video";

    case "document": {
      if (message.caption) return message.caption;
      if (message.document?.file_name)
        return `📄 ${message.document.file_name}`;
      return "📄 Document";
    }

    case "sticker":
      return message.sticker?.emoji || "👍 Sticker";

    case "member_join": {
      const users = (message.new_chat_members || []).map((u: any) =>
        u.username ? `@${u.username}` : u.first_name,
      );
      return `👤 ${users.join(", ")} joined`;
    }

    case "member_leave": {
      const u = message.left_chat_member;
      const name = u?.username ? `@${u.username}` : u?.first_name || "user";
      return `👋 ${name} left`;
    }

    default:
      return "[other]";
  }
}
