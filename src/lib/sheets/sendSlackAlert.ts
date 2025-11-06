// -----------------------------------------------------------------------------
// Send alert message to Slack via webhook
// - Uses SLACK_WEBHOOK_URL from env
// - Mentions "Pochi" by default
// -----------------------------------------------------------------------------

/**
 * Send a formatted alert message to Slack.
 *
 * @param message  Text to send (plain text or Slack markdown)
 */
export async function sendSlackAlert(message: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn(
      "[sendSlackAlert] SLACK_WEBHOOK_URL is not set; skip Slack notification.",
    );
    return;
  }

  // --- Compose message body ---------------------------------------------------
  const mention = "<@U02A6MHJSMP>"; // "Pochi"
  const prefix = `🚨 ${mention}\n`;
  const text = `${prefix}${message}`;

  // --- Post message -----------------------------------------------------------
  const startHr = process.hrtime.bigint();

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      mrkdwn: true,
      link_names: 1, // allow @mention resolution
    }),
  });

  const durationMs = Number((process.hrtime.bigint() - startHr) / 1_000_000n);

  if (!resp.ok) {
    const body = await resp.text();
    console.warn(
      `[sendSlackAlert] post failed: ${resp.status} ${body?.slice(0, 300) || ""}`,
    );
  } else {
    console.log(`[sendSlackAlert] notified in ${durationMs}ms`);
  }
}
