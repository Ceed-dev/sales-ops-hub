// -----------------------------------------------------------------------------
// Vertex AI (Gemini) client for generating structured report summaries.
//
// ✅ Behavior Summary (finishReason Handling)
// -----------------------------------------------------------------------------
// 1. STOP (Normal completion)
//    → Parse JSON normally and return structured { summary, bullets }.
//
// 2. MAX_TOKENS / LENGTH (Output truncated)
//    → Retry "continue generation" until:
//       - finishReason becomes STOP, OR
//       - maximum retry count (MAX_ATTEMPTS) reached.
//      Then merge all partial outputs and parse safely.
//
// 3. CONTENT_FILTERED (Content blocked by safety filter)
//    → Return a fixed safe message ("⚠️ The content was filtered...").
//
// 4. UNKNOWN / ERROR / other unexpected cases
//    → Fallback: return raw text as summary and empty bullets.
//
// ✅ Guaranteed Output Format
// Always returns a safe, typed object:
// { summary: string; bullets: any[]; usage: Record<string, any>; finishReason: string }
// So that Slack or Firestore can handle results safely without breaking.
// -----------------------------------------------------------------------------

/**
 * Calls Vertex AI (Gemini) to generate a structured summary.
 *
 * @param body - The request body prepared by buildReportPayload().
 * @returns Object containing summary text, structured bullets, usage metadata, and finish reason.
 */
export async function summarizeWithAI(body: Record<string, any>): Promise<{
  summary: string;
  bullets: any[];
  usage: Record<string, any>;
  finishReason: string;
}> {
  // ---------------------------------------------------------------------------
  // 0. Environment setup
  // ---------------------------------------------------------------------------
  const apiKey = process.env.VERTEX_API_KEY;
  if (!apiKey) throw new Error("VERTEX_API_KEY is not set");

  const endpoint =
    "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent";

  // Helper: safely parse JSON (even if incomplete)
  const tryParse = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {}
      }
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // 1. Helper: Single API request to Vertex AI
  // ---------------------------------------------------------------------------
  async function callVertexAI(requestBody: any) {
    const res = await fetch(`${endpoint}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) throw new Error(`Vertex API request failed (${res.status})`);
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // 2. First request
  // ---------------------------------------------------------------------------
  let json: any = await callVertexAI(body);
  let finishReason: string = json?.candidates?.[0]?.finishReason ?? "UNKNOWN";
  let usage: Record<string, any> = json?.usageMetadata ?? {};
  let rawText: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  console.log("[VertexAI] finishReason:", finishReason);
  console.log("[VertexAI] usage:", usage);

  // ---------------------------------------------------------------------------
  // 3. Retry loop for MAX_TOKENS / LENGTH
  // ---------------------------------------------------------------------------
  const MAX_ATTEMPTS = 5;
  let attempts = 0;

  // Keep the latest valid JSON
  let latestParsed: any = tryParse(rawText);

  while (
    (finishReason === "MAX_TOKENS" || finishReason === "LENGTH") &&
    attempts < MAX_ATTEMPTS
  ) {
    attempts++;
    console.warn(
      `[VertexAI] Output truncated. Retrying continuation... (Attempt ${attempts})`,
    );

    // Build continuation prompt
    const contBody = {
      ...body,
      contents: [
        ...(body.contents || []),
        // Send the latest JSON or the previous text abbreviated
        {
          role: "model",
          parts: [
            {
              text: latestParsed
                ? JSON.stringify(latestParsed).slice(0, 2000)
                : rawText.slice(-2000),
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              text: "Please continue and complete the JSON output fully. Return only valid JSON, no repetition.",
            },
          ],
        },
      ],
    };

    try {
      const contJson: any = await callVertexAI(contBody);
      const contText =
        contJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const contFinishReason =
        contJson?.candidates?.[0]?.finishReason ?? finishReason;

      // Do not concatenate rawText sequentially
      // Instead, check if continuation contains complete JSON
      const parsed = tryParse(contText);
      if (parsed) {
        latestParsed = parsed; // replace with newest complete JSON
        rawText = contText; // replace instead of +=
      } else {
        // fallback: append only short snippet for inspection
        rawText += "\n" + contText.slice(0, 500);
      }

      finishReason = contFinishReason;

      if (finishReason === "STOP") {
        console.log("[VertexAI] Continuation succeeded.");
        break;
      }
    } catch (err) {
      console.warn("[VertexAI] Continuation request failed:", err);
      break;
    }
  }

  if (attempts >= MAX_ATTEMPTS) {
    console.warn(
      "[VertexAI] Reached max continuation attempts, returning partial result.",
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Parse & handle each finishReason type
  // ---------------------------------------------------------------------------
  let summary = "";
  let bullets: any[] = [];

  const finalParsed = latestParsed || tryParse(rawText);
  if (finalParsed) {
    summary = finalParsed.summary ?? "";
    bullets = Array.isArray(finalParsed.bullets) ? finalParsed.bullets : [];
  } else {
    summary = rawText;
  }

  switch (finishReason) {
    case "STOP":
      // ✅ Normal completion - do nothing extra
      break;

    case "MAX_TOKENS":
    case "LENGTH":
      // ⚠️ Truncated output after retries
      summary ||= "⚠️ The summary may be incomplete due to token limits.";
      break;

    case "CONTENT_FILTERED":
      // 🚫 Content blocked
      summary = "⚠️ The content was filtered by safety policies.";
      bullets = [];
      break;

    default:
      // ❌ Unknown or other failures
      summary ||= "⚠️ No valid output generated.";
      bullets = bullets ?? [];
  }

  // ---------------------------------------------------------------------------
  // 5. Return safe structured output
  // ---------------------------------------------------------------------------
  return {
    summary: summary.trim(),
    bullets,
    usage,
    finishReason,
  };
}
