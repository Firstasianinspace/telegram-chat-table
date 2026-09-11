/**
 * SQLite schema for the chat-analyzer message store.
 *
 * Design notes (see docs/architecture/ENTERPRISE_TABLE_ARCHITECTURE.md for the
 * measured numbers behind these decisions):
 *
 * - `id` is declared `INTEGER PRIMARY KEY`, which in SQLite makes it an alias
 *   for the rowid. Every index therefore implicitly breaks ties in rowid
 *   (id) order for free — no compound `(col, id)` index is needed as long as
 *   the query's secondary ORDER BY direction on `id` matches the primary
 *   column's direction (DESC ties -> id DESC, ASC ties -> id ASC). Mismatched
 *   tie-break direction forces a temp b-tree sort even with a perfect index
 *   in place — measured ~160x slower on a 1M-row table.
 * - `date_key`/`hour`/`day_of_week` are derived at write time (mirrors the
 *   old Dexie `ChatMessageWithDerived` fields) so analytics grouping never
 *   needs a per-row date function call over the whole table.
 * - Everything not needed for filtering/sorting/rendering the table
 *   (reactions, textEntities, file.*, editedTimestamp, viaBot, serviceActor,
 *   discardReason) is packed into a single `extra` JSON column. These fields
 *   are read once per visible row (never filtered or sorted on by the UI —
 *   see tableColumns.ts), so there is no query that needs them indexed.
 */

export const SCHEMA_VERSION = 1;

export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  date_key INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  text TEXT,
  text_length INTEGER NOT NULL DEFAULT 0,
  service_action TEXT,
  extra TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  is_me INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * One entry per query the UI can actually issue — see the "Query matrix"
 * section of ENTERPRISE_TABLE_ARCHITECTURE.md for which query uses which
 * index. No speculative indexes.
 */
export const CREATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_type_timestamp ON messages(type, timestamp);
CREATE INDEX IF NOT EXISTS idx_type_from_name ON messages(type, from_name);
CREATE INDEX IF NOT EXISTS idx_type_text_length ON messages(type, text_length);
CREATE INDEX IF NOT EXISTS idx_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_from_id_timestamp ON messages(from_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_from_name ON messages(from_name);
CREATE INDEX IF NOT EXISTS idx_text_length ON messages(text_length);
CREATE INDEX IF NOT EXISTS idx_date_key ON messages(date_key);
CREATE INDEX IF NOT EXISTS idx_type_service_action ON messages(type, service_action);
`;

export const INDEX_NAMES = [
  'idx_type_timestamp',
  'idx_type_from_name',
  'idx_type_text_length',
  'idx_type',
  'idx_from_id_timestamp',
  'idx_timestamp',
  'idx_from_name',
  'idx_text_length',
  'idx_date_key',
  'idx_type_service_action',
] as const;

/**
 * Maintaining all 10 indexes above during many small incremental inserts
 * (a fresh file import or mock-data generation run, which arrive as a
 * stream of a few-thousand-row chunks) measured as an increasingly severe
 * slowdown as the table grows — 33ms per 1,000-row batch at 1,000 rows,
 * 450ms per batch at 60,000 rows, with no indexes at all staying flat at
 * ~10-14ms regardless of table size. Dropping the indexes for the
 * duration of a bulk-write session and rebuilding them once at the end
 * (see sqlite.worker.ts's beginBulkWrite/endBulkWrite) avoids paying that
 * cost on every batch.
 */
export const DROP_INDEXES_SQL = INDEX_NAMES.map((name) => `DROP INDEX IF EXISTS ${name};`).join('\n');

/** Applied once per connection. temp_store=MEMORY alone took ORDER BY-with-mismatched-tie-break
 * from ~9.8s to ~1.8s at 1M rows in the prototype; combined with matched tie-break direction
 * (see queryBuilder.ts) the same query drops to ~11ms. */
export const CONNECTION_PRAGMAS_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA temp_store=MEMORY;
PRAGMA cache_size=-131072;
PRAGMA mmap_size=268435456;
PRAGMA foreign_keys=OFF;
`;

export function computeDerivedFields(timestampMs: number): {
  dateKey: number;
  hour: number;
  dayOfWeek: number;
} {
  const d = new Date(timestampMs);
  const dateKey = d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
  return { dateKey, hour: d.getHours(), dayOfWeek: d.getDay() };
}

export function dateKeyToIsoDate(dateKey: number): string {
  const year = Math.floor(dateKey / 10_000);
  const month = Math.floor((dateKey % 10_000) / 100);
  const day = dateKey % 100;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isoDateToDateKey(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return (year ?? 0) * 10_000 + (month ?? 0) * 100 + (day ?? 0);
}
