import type { NotificationType } from "../types/notification.js";

/**
 * Build Slack message text based on notification type.
 */
export const buildNotificationText = (
  type: NotificationType,
  mentions: string,
  chatTitle: string,
  fileName: string,
  caption: string,
  createdAt: string,
): string => {
  // ---------------------------------------------------------------------------
  // Common detail block
  // ---------------------------------------------------------------------------
  const baseInfo =
    [
      `• Document: *${fileName}*`,
      caption ? `• Caption: *${caption}*` : "",
      `• Sent at: *${createdAt}*`,
    ]
      .filter(Boolean)
      .join("\n") + "\n";

  // ---------------------------------------------------------------------------
  // Message text by notification type
  // ---------------------------------------------------------------------------
  switch (type) {
    // --- Follow-up three hours after the bot was added to the chat ------------
    case "follow_up_bot_join_call_check":
      return `${mentions}
Reminder: A new bot was added to *"${chatTitle}"* on *${createdAt}*.
Please check whether the call link has been sent to the group.`;

    // --- Proposal follow-ups --------------------------------------------------
    case "follow_up_proposal_1st":
      return `${mentions}
It's been 3 days since you sent the proposal document in *"${chatTitle}"*.
${baseInfo}
Please follow up when you have a moment.`;

    case "follow_up_proposal_2nd":
      return `${mentions}
It's been 6 days since you sent the proposal document in *"${chatTitle}"*.
${baseInfo}
If there has been no response, please send a gentle reminder.`;

    // --- Invoice follow-ups ---------------------------------------------------
    case "follow_up_invoice_1st":
      return `${mentions}
It's been 2 days since you sent the invoice in *"${chatTitle}"*.
${baseInfo}
Please check if the client has received it.`;

    case "follow_up_invoice_2nd":
      return `${mentions}
It's been 4 days since you sent the invoice in *"${chatTitle}"*.
${baseInfo}
If the payment is still pending, please follow up with the client.`;

    // --- Calendly follow-up ---------------------------------------------------
    case "follow_up_calendly":
      return `${mentions}
It's been one day since you sent the Calendly link in *"${chatTitle}"*.
${baseInfo}
Please check if a meeting has been scheduled.`;

    // --- Agreement follow-ups -------------------------------------------------
    case "follow_up_agreement_1st":
      return `${mentions}
It's been 2 days since you sent the agreement in *"${chatTitle}"*.
${baseInfo}
Please confirm whether the client has reviewed it.`;

    case "follow_up_agreement_2nd":
      return `${mentions}
It's been 4 days since you sent the agreement in *"${chatTitle}"*.
${baseInfo}
If there has been no update, please reach out again.`;

    // --- Fallback (should not normally occur) --------------------------------
    default:
      return `${mentions}
Follow-up reminder for *"${chatTitle}"*.
${baseInfo}`;
  }
};
