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
 * Collapse obvious repetitions, normalize whitespace, and hard-cap length.
 * - Repetition: removes immediate repeats of 10+ char sequences (…aaaa aaaa…)
 * - Whitespace: collapses runs of spaces/newlines
 * - Length: trims to maxLen chars and appends ellipsis
 */
function sanitizeEvidenceExcerpt(input: unknown, maxLen = 120): string {
  if (typeof input !== "string") return "";
  let s = input;
  s = s.replace(/(.{10,}?)\1+/g, "$1"); // naive repetition
  s = s.replace(/\s+/g, " ").trim(); // whitespace normalize
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

/** Generic clamp for interim raw text */
function dedupeAndClamp(s: string, max = 2000): string {
  return (s || "")
    .replace(/(.{10,}?)\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Walks the parsed JSON and sanitizes `evidence[].textExcerpt` in-place.
 * Safe against unexpected shapes.
 */
function sanitizeModelBullets(parsed: any): any {
  if (!parsed || !Array.isArray(parsed.bullets)) return parsed;
  for (const b of parsed.bullets) {
    if (!b || !Array.isArray(b.evidence)) continue;
    for (const ev of b.evidence) {
      if (!ev) continue;
      ev.textExcerpt = sanitizeEvidenceExcerpt(ev.textExcerpt, 120);
    }
  }
  return parsed;
}

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
        } catch { }
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

  // --- Observability: request summary (no payload dump) ---
  const approxTokens = (s: string) => Math.ceil((s ?? "").length / 4);
  const schemaCaps = {
    summaryMax: (body.responseSchema as any)?.properties?.summary?.maxLength,
    bulletsMax: (body.responseSchema as any)?.properties?.bullets?.maxItems,
    evidenceMax: (body.responseSchema as any)?.properties?.bullets?.items
      ?.properties?.evidence?.maxItems,
    textExcerptMax: (body.responseSchema as any)?.properties?.bullets?.items
      ?.properties?.evidence?.items?.properties?.textExcerpt?.maxLength,
  };
  const contentsStr = JSON.stringify(body.contents ?? []);
  console.log("[AI:req:init]", {
    genCfg: body.generationConfig,
    schemaCaps,
    inputChars: contentsStr.length,
    inputTokEst: approxTokens(contentsStr),
  });

  let json: any = await callVertexAI(body);
  let finishReason: string = json?.candidates?.[0]?.finishReason ?? "UNKNOWN";
  let usage: Record<string, any> = json?.usageMetadata ?? {};
  let rawText: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  console.log("[AI:res:init]", {
    finishReason,
    usage, // includes prompt/candidates/total
  });

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

    let safeLatestText: string | undefined;
    if (latestParsed) {
      const clone = JSON.parse(JSON.stringify(latestParsed));
      sanitizeModelBullets(clone);
      safeLatestText = JSON.stringify(clone).slice(0, 2000);
    }

    // Build continuation prompt
    const contBody: Record<string, any> = {
      ...(body as any),
      contents: [
        ...(body.contents || []),
        // Send the latest JSON or the previous text abbreviated
        {
          role: "model",
          parts: [
            {
              text:
                safeLatestText ?? dedupeAndClamp(rawText.slice(-2000), 2000),
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              text:
                "Please continue the JSON output briefly — only add the remaining fields if any. " +
                "If the structure already seems complete, return the same JSON as-is. " +
                "Keep total output short (under 1,500 characters).",
            },
          ],
        },
      ],
    };

    console.log(`[AI:cont:${attempts}] send`, {
      useSafeLatest: Boolean(safeLatestText),
      safeLatestChars: safeLatestText?.length ?? 0,
      rawTailChars: rawText.slice(-2000).length,
      genCfg: contBody.generationConfig,
    });

    try {
      const contJson: any = await callVertexAI(contBody);

      const contText =
        contJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const contFinishReason =
        contJson?.candidates?.[0]?.finishReason ?? finishReason;

      console.log(`[AI:cont:${attempts}] recv`, {
        finishReason: contFinishReason,
        usage: contJson?.usageMetadata,
        contTextChars: (
          contJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
        ).length,
      });

      // Do not concatenate rawText sequentially
      // Instead, check if continuation contains complete JSON
      const parsed = tryParse(contText);
      if (parsed) {
        sanitizeModelBullets(parsed);
        latestParsed = parsed;
        rawText = JSON.stringify(parsed).slice(0, 2000);
      } else {
        rawText = dedupeAndClamp(rawText + "\n" + contText, 1200);
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
    sanitizeModelBullets(finalParsed);
    summary = finalParsed.summary ?? "";
    bullets = Array.isArray(finalParsed.bullets) ? finalParsed.bullets : [];
  } else {
    const clipped = dedupeAndClamp(rawText || "", 400);
    summary = clipped + ((rawText?.length ?? 0) > 400 ? "…" : "");
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

  console.log("[AI:final]", {
    finishReason,
    summaryLen: (summary ?? "").length,
    bulletsCount: Array.isArray(bullets) ? bullets.length : 0,
  });

  return {
    summary: summary.trim(),
    bullets,
    usage,
    finishReason,
  };
}
