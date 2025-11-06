// -----------------------------------------------------------------------------
// Update or insert tg_chats/{chatId}.phase when the lifecycle phase advances.
// - Monotonic (never downgrade)
// - Idempotent (same phase + same messageId → no update)
// -----------------------------------------------------------------------------

import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import type { ChatPhase } from "../../types/chat.js";

// -----------------------------------------------------------------------------
// Phase priority mapping (higher = later in lifecycle)
// -----------------------------------------------------------------------------
const PHASE_PRIORITY: Record<ChatPhase, number> = {
  BotAdded: 1,
  CalendlyLinkShared: 2,
  ProposalSent: 3,
  AgreementSent: 4,
  InvoiceSent: 5,
};

// -----------------------------------------------------------------------------
// Input type for the next phase
// -----------------------------------------------------------------------------
type NextPhase = {
  value: ChatPhase;
  ts: Timestamp;
  messageId: string;
};

// -----------------------------------------------------------------------------
// Main function
// -----------------------------------------------------------------------------
export async function upsertChatPhaseIfAdvanced(
  chatId: string,
  next: NextPhase,
): Promise<boolean> {
  const ref = db.collection("tg_chats").doc(chatId);
  const snap = await ref.get();

  // ---------------------------------------------------------------------------
  // Case 1: Chat document does not exist → create new with initial phase
  // ---------------------------------------------------------------------------
  if (!snap.exists) {
    await ref.set({ phase: next }, { merge: true });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Case 2: Chat document exists → check current phase
  // ---------------------------------------------------------------------------
  const curr = (snap.data() as any)?.phase as
    | { value: ChatPhase; ts?: Timestamp; messageId?: string }
    | undefined;

  // Idempotent: skip if same phase and same messageId
  if (curr?.value === next.value && curr?.messageId === next.messageId) {
    return false;
  }

  // Determine priorities
  const currPri = curr?.value ? PHASE_PRIORITY[curr.value] : 0;
  const nextPri = PHASE_PRIORITY[next.value];

  // ---------------------------------------------------------------------------
  // Case 3: Update only if phase advances (monotonic increase)
  // ---------------------------------------------------------------------------
  if (nextPri > currPri || !curr?.value) {
    await ref.update({ phase: next });
    return true;
  }

  // No update (same or lower phase)
  return false;
}
