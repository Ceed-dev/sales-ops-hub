/**
 * Leave a Telegram chat (best-effort).
 *
 * - Returns `true` if Telegram API returns 2xx.
 * - Returns `false` on non-2xx or any exception.
 * - Never logs the bot token. Truncates response body in logs.
 */
export async function leaveChat(chatId: string): Promise<boolean> {
  // 1) Validate environment
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[telegram] leaveChat skipped: TELEGRAM_BOT_TOKEN is not set");
    return false;
  }

  // 2) Build API URL & payload
  const url = `https://api.telegram.org/bot${token}/leaveChat`;
  const payload = { chat_id: chatId };

  try {
    // 3) Call Telegram API
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // 4) Handle non-2xx
    if (!resp.ok) {
      const body = await safeText(resp);
      console.warn(
        `[telegram] leaveChat failed: ${resp.status} ${truncate(body, 300)}`,
      );
      return false;
    }

    // 5) Success
    return true;
  } catch (e) {
    // 6) Network/unknown error
    console.warn("[telegram] leaveChat error:", e);
    return false;
  }
}

/** Safely read response text (guard against unexpected errors). */
async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/** Truncate a string to the specified length with ellipsis. */
function truncate(input: string, max: number): string {
  if (!input) return "";
  return input.length > max ? `${input.slice(0, max)}…` : input;
}
