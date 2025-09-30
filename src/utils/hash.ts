// -----------------------------------------------------------------------------
// Small hashing utilities
// -----------------------------------------------------------------------------
import { createHash } from "crypto";

/** Deterministic short id (24 hex chars) for idempotency keys, etc. */
export function hashId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}
