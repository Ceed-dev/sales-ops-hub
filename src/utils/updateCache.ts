// -----------------------------------------------------------------------------
// Telegram update_id deduplication (in-memory LRU cache).
// Prevents reprocessing of the same update multiple times.
// -----------------------------------------------------------------------------

// Max number of update_ids to keep in memory
export const MAX_CACHE = 1000;

// Internal cache state
const seenUpdateIds = new Set<number>();
const updateQueue: number[] = [];

/**
 * Checks if an update_id has already been seen.
 * - If new → adds it to the cache and returns false
 * - If duplicate → returns true
 *
 * @param updateId - Telegram update_id
 * @returns boolean - true if already processed, false if new
 */
export function isDuplicateUpdateId(updateId: number): boolean {
  // Duplicate check
  if (seenUpdateIds.has(updateId)) return true;

  // Add new update_id to cache
  seenUpdateIds.add(updateId);
  updateQueue.push(updateId);

  // Trim cache size (FIFO eviction)
  if (updateQueue.length > MAX_CACHE) {
    const oldest = updateQueue.shift();
    if (oldest !== undefined) seenUpdateIds.delete(oldest);
  }

  return false;
}
