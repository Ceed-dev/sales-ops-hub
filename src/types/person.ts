// Firestore document: people/{personId}
// - personId is a platform-agnostic UUID (Source of Truth for "a human").
// - All platform IDs are stored as strings; timestamps are Firestore Timestamp (UTC).
// - Keep platform links minimal (SoT = string IDs). Add references later only if needed.

import { Timestamp } from "firebase-admin/firestore";

// -----------------------------------------------------------------------------
// Linked platform types
// -----------------------------------------------------------------------------
interface TelegramLink {
  userId: string; // tg_users/{userId} (string SoT)
  username: string | null; // "pochi_udon" (nullable, mutable)
  firstName: string | null; // snapshot at last link update
  lastName: string | null; // snapshot at last link update
}

// Slack link with per-workspace notify prefs (unified)
// - Keep ID mapping tiny & stable
// - Put mutable ops settings under `prefs` to avoid mixing concerns at the top level
interface SlackLink {
  // --- IDs (SoT on Slack side) ---
  teamId: string; // "Txxxxxx" (workspace)
  userId: string; // "Uxxxxxx" (<@Uxxxxxx> mention target)

  // --- Optional UI snapshots (mutable; don't rely on them for logic) ---
  username?: string | null;
  displayName?: string | null;
  email?: string | null;

  // --- Ops settings (mutable) ---
  prefs?: {
    enabled?: boolean; // notifications ON/OFF
    defaultChannelId?: string | null; // "Cxxxxxx"
    channels?: string[]; // additional "Cxxxxxx"
  };
}

// -----------------------------------------------------------------------------
// Main Document
// -----------------------------------------------------------------------------
export interface PersonDoc {
  // --- Identity (platform-agnostic) ---
  personId: string; // UUID (SoT for a human)
  displayName: string | null; // unified name for UI; optional

  // --- Linked accounts ---
  telegram?: TelegramLink; // single TG account (optional)
  slack?: SlackLink[]; // allow multiple workspaces (0..n)

  // --- Ops ---
  createdAt: Timestamp; // first time this person was created
  updatedAt: Timestamp; // last time this doc was updated
}
