// -----------------------------------------------------------------------------
// Vertex AI (Gemini) client for generating structured report summaries.
// - Sends the prepared JSON payload to the Vertex API.
// - Parses the model response safely and returns summary data.
// - Includes finishReason and usage metadata for logging/monitoring.
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
  // --- Environment check ---
  const apiKey = process.env.VERTEX_API_KEY;
  if (!apiKey) throw new Error("VERTEX_API_KEY is not set");

  // --- Endpoint definition ---
  const endpoint =
    "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent";

  // --- API request ---
  const res = await fetch(`${endpoint}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as any;

  // --- Extract key response fields ---
  const finishReason: string = json?.candidates?.[0]?.finishReason ?? "UNKNOWN";
  const usage: Record<string, any> = json?.usageMetadata ?? {};
  const rawText: string =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  console.log("[VertexAI] finishReason:", finishReason);
  console.log("[VertexAI] usage:", usage);

  // --- Attempt to parse the model output as JSON ---
  try {
    const parsed = JSON.parse(rawText);
    return {
      summary: parsed.summary ?? "",
      bullets: parsed.bullets ?? [],
      usage,
      finishReason,
    };
  } catch {
    console.warn("[VertexAI] Output was not valid JSON. Returning raw text.");
    return {
      summary: rawText,
      bullets: [],
      usage,
      finishReason,
    };
  }
}
