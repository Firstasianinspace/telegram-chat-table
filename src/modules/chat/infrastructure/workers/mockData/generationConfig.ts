/**
 * Generation configuration types and defaults.
 *
 * Centralises all magic numbers so callers import constants instead of
 * repeating literal values. Also defines the unified GenerationOptions object
 * used by both Start and Add commands, ensuring API consistency (OCP, SRP).
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GenerationOptions {
  totalMessages: number;
  chunkSize: number;
  spanDays: number;
  /** Monotonically increasing ID to assign to the first generated message. */
  startId: number;
  /** Optional seed — 0 means derive from Date.now(). */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Defaults (single source of truth for UI and worker)
// ---------------------------------------------------------------------------

export const DEFAULT_TOTAL_MESSAGES = 200_000;
export const DEFAULT_CHUNK_SIZE = 10_000;
export const DEFAULT_SPAN_DAYS = 180;
export const DEFAULT_ADD_COUNT = 10_000;
export const DEFAULT_REMOVE_COUNT = 10_000;

/**
 * Upper bound the generator UI allows.
 *
 * As of the SQLite + OPFS migration (see
 * docs/architecture/ENTERPRISE_TABLE_ARCHITECTURE.md), this is
 * 1,000,000 — verified via a keyset-pagination query matrix (every
 * filter combination the UI exposes × every sortable column) measured
 * against a real SQLite engine at 1,000,000 rows, all under the 500ms
 * budget. This ceiling holds only on the SQLite backend: when
 * chatStorageBootstrap.ts falls back to the legacy IndexedDB
 * repositories (no cross-origin isolation, or the SQLite writer lock is
 * held by another tab), the table silently reverts to the old,
 * pre-migration behavior — correct but only verified consistent up to
 * 200,000 rows, same as before. The generator itself has no way to know
 * which backend is active at generation time, so it does not lower this
 * cap in that case; see "Known limitations" in
 * ENTERPRISE_TABLE_ARCHITECTURE.md.
 */
export const MAX_TOTAL_MESSAGES = 1_000_000;

export const DEFAULT_GENERATION_OPTIONS: Readonly<GenerationOptions> = {
  totalMessages: DEFAULT_TOTAL_MESSAGES,
  chunkSize: DEFAULT_CHUNK_SIZE,
  spanDays: DEFAULT_SPAN_DAYS,
  startId: 0,
  seed: 0,
} as const;
