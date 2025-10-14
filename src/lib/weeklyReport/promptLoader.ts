// -----------------------------------------------------------------------------
// Load the weekly-report AI section prompt (Markdown) from the filesystem.
// - Normalizes line breaks to LF
// - Trims only the trailing whitespace at the very end (keeps body as-is)
// - Uses a simple in-memory cache to avoid repeated disk I/O
// -----------------------------------------------------------------------------

// ===== Imports =====
import { readFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { resolve } from "node:path";

// ===== Constants =====
export const DEFAULT_PROMPT_PATH = "src/prompts/report_ai_section.md";

// ===== In-memory cache =====
const cache = new Map<string, string>();

// ===== Public API =====

/**
 * Load the report AI section prompt (.md) and return it as a string.
 * - If already cached, returns the cached value.
 * - Falls back to an alternative source path if the primary doesn't exist.
 */
export async function loadReportAiSectionPrompt(
  filePath: string = DEFAULT_PROMPT_PATH,
): Promise<string> {
  const key = resolve(process.cwd(), filePath);
  if (cache.has(key)) return cache.get(key)!;

  const abs = await resolveExistingPath(key);
  const raw = await readFile(abs, "utf8");

  // Normalize CRLF -> LF; trim only at the very end of the file.
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\s+$/u, "");

  cache.set(key, normalized);
  return normalized;
}

/**
 * Clear the prompt cache (useful for tests and hot-reload).
 * - If a path is provided, clears only that entry.
 * - If omitted, clears the entire cache.
 */
export function clearPromptCache(path?: string): void {
  if (!path) {
    cache.clear();
    return;
  }
  cache.delete(resolve(process.cwd(), path));
}

// ===== Internals =====

/**
 * Resolve an existing absolute file path.
 * - Tries the provided absolute path first.
 * - Falls back to src/prompts/report_ai_section.md if needed.
 * - Throws if not found.
 */
async function resolveExistingPath(primaryAbs: string): Promise<string> {
  // (1) As-is
  if (await exists(primaryAbs)) return primaryAbs;

  // (2) Source-friendly fallback
  const alt = resolve(process.cwd(), "src", "prompts", "report_ai_section.md");
  if (await exists(alt)) return alt;

  throw new Error(
    `Prompt file not found. Tried:\n- ${primaryAbs}\n- ${alt}\n` +
      `Set PROMPT_REPORT_AI_SECTION_PATH if located elsewhere.`,
  );
}

/** fs.exists wrapper using access(F_OK). */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}
