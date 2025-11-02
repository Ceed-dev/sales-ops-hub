// -----------------------------------------------------------------------------
// Sends a structured AI-generated report (summary + timeline bullets) to Slack.
// Compatible with the Vertex AI response schema defined in buildReportPayload.ts.
// -----------------------------------------------------------------------------
//
// Example payload shape (from summarizeWithAI):
// {
//   summary: "High-level summary text",
//   bullets: [
//     {
//       point: "Main event or task summary",
//       timeline: [
//         { when: "2025-10-08", event: "Document sent", owner: "Jaz", status: "done" },
//         ...
//       ],
//       evidence: [ ... ]
//     }
//   ]
// }
// -----------------------------------------------------------------------------

/**
 * Sends a formatted report message to Slack using an Incoming Webhook.
 *
 * @param result - Object returned from summarizeWithAI() (includes summary and bullets)
 * @param chatTitle - Title or name of the Telegram chat
 */
export async function sendReportToSlack(
  result: {
    summary: string;
    bullets: {
      point: string;
      timeline?: {
        when?: string;
        event?: string;
        owner?: string;
        status?: "planned" | "in_progress" | "done" | "blocked";
        deadline?: boolean;
      }[];
      evidence?: {
        msgId: string;
        sender: { id: string; displayName?: string; username?: string };
        sentAt?: string;
        textExcerpt?: string;
        reason?: string;
      }[];
    }[];
    finishReason: string;
  },
  chatTitle: string,
): Promise<void> {
  try {
    const webhookUrlSecond = process.env.SLACK_WEBHOOK_URL_SECOND;
    if (!webhookUrlSecond)
      throw new Error("SLACK_WEBHOOK_URL_SECOND is not set");

    // --- Build message text ---
    const lines: string[] = [];

    // Header
    lines.push(`📑 *Weekly Report Summary*`);
    lines.push(`Chat: *${chatTitle}*`);
    lines.push("━━━━━━━━━━━━━━━");
    lines.push("");
    // lines.push(`*Summary:*`);
    // lines.push((result.summary || "").trim() || "No updates this week.");
    // lines.push("");

    const r = result.finishReason ?? "UNKNOWN";
    if (r !== "STOP") {
      const mention = "<@U02A6MHJSMP>"; // Mention "Pochi"
      const status =
        r === "MAX_TOKENS" || r === "LENGTH"
          ? "⚠️ Output was truncated (auto-recovered)"
          : r === "CONTENT_FILTERED"
            ? "🚫 Blocked by safety filter"
            : `❓ ${r}`;
      lines.push(`${mention} *Status:* ${status}`);
      lines.push("");
    }

    const hasBullets =
      Array.isArray(result.bullets) && result.bullets.length > 0;

    if (hasBullets) {
      lines.push("*Key Points:*");

      // Bullet points with limited timeline details
      for (const bullet of result.bullets ?? []) {
        lines.push(`• *${bullet.point.trim()}*`);

        // Add timeline info if available
        if (bullet.timeline?.length) {
          const timelineLines = bullet.timeline
            .map((t) => {
              const when = t.when
                ? new Date(t.when).toISOString().split("T")[0]
                : "";
              const event = t.event ?? "";
              const owner = t.owner ? ` (${t.owner})` : "";
              const status = t.status ? ` — ${t.status}` : "";
              return `  ↳ ${when}: ${event}${owner}${status}`;
            })
            .slice(0, 3); // show up to 3 per bullet
          lines.push(...timelineLines);
        }
      }
    }

    const text = lines.join("\n");

    // --- Send to Slack ---
    const resp = await fetch(webhookUrlSecond, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mrkdwn: true, link_names: 1 }),
    });

    // --- Handle Slack response ---
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[Slack] ❌ Failed: HTTP ${resp.status} - ${errText}`);
      throw new Error(`Slack webhook failed with status ${resp.status}`);
    }

    console.log("[Slack] ✅ Report sent successfully.");
  } catch (err) {
    console.error("[Slack] ❌ Failed to send report:", err);
    throw err;
  }
}
