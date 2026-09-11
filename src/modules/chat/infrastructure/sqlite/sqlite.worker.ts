/**
 * The one and only place a SQLite connection is opened. Runs in a dedicated
 * Web Worker because the OPFS SyncAccessHandle Pool VFS requires synchronous
 * file access, which is only available off the main thread.
 *
 * Multi-tab safety: before touching OPFS, this worker takes an exclusive Web
 * Locks lock (`ifAvailable`, non-queuing). If another tab already holds it,
 * this worker reports `{ locked: true }` and never opens the OPFS pool —
 * the SyncAccessHandle Pool VFS itself would throw on a second concurrent
 * open, and there is no seamless cross-tab read-sharing implemented yet (see
 * "Known limitation: multi-tab" in ENTERPRISE_TABLE_ARCHITECTURE.md). The
 * caller (chatStorageBootstrap.ts) falls back to the IndexedDB repositories
 * for that tab when this happens — never corrupts data, just serializes
 * access to one tab at a time.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { CREATE_SCHEMA_SQL, CREATE_INDEXES_SQL, DROP_INDEXES_SQL, CONNECTION_PRAGMAS_SQL } from './schema';
import {
  buildCountQuery,
  buildFetchPageQuery,
  buildExactRankSeekQuery,
  buildPerTypeCountQuery,
  pickBranchForApproximateRank,
  resolveSort,
} from './queryBuilder';
import { messageToRow, rowToMessage, participantToRow, rowToParticipant, type MessageRow } from './rowMapping';
import type {
  WorkerRequestEnvelope,
  WorkerOutboundMessage,
  InitResult,
  FetchPageParams,
  FetchPageResult,
  ResolveRankParams,
  ResolveRankResult,
  SaveMessagesParams,
  MigrationProgress,
  AnalyticsTopSendersParams,
  AnalyticsDateRangeParams,
  LoadCallsParams,
} from './sqliteProtocol';
import type { ChatMessage, ChatParticipant } from '../../domain/entities/types';
import type { Cursor } from '../../domain/interfaces/IChatRepository';
import type { SenderCount, DailyVolumePoint, HeatmapPoint, TimeSlotCount } from '../../application/queries/analyticsTypes';
import { getTimeSlot } from '../../application/queries/analyticsTypes';
import type { PhoneCall } from '../../../phone-call/domain/types';
import { isoDateToDateKey } from './schema';

const LOCK_NAME = 'chat-analyzer-sqlite-writer';
const DB_FILE = '/chat-analyzer.sqlite3';
const POOL_NAME = 'chat-analyzer-pool';
const MIGRATION_META_KEY = 'migrated_from_indexeddb_v1';

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    bind(params: unknown[]): void;
    step(): boolean;
    reset(): void;
    finalize(): void;
  };
  selectObjects(sql: string, params?: unknown[]): Record<string, unknown>[];
  close(): void;
}

let db: SqliteDb | undefined;
let locked = false;

function post(message: WorkerOutboundMessage): void {
  (globalThis as unknown as { postMessage(m: unknown): void }).postMessage(message);
}

function scalarCount(sql: string, params: (string | number)[] = []): number {
  const rows = db!.selectObjects(sql, params);
  return (rows[0]?.c as number | undefined) ?? 0;
}

function run(sql: string, params: (string | number | null)[] = []): void {
  const stmt = db!.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.reset();
    stmt.finalize();
  }
}

async function acquireLockOrReportLocked(): Promise<boolean> {
  const locksApi = (globalThis as unknown as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locksApi) return true; // Web Locks unavailable (very old browser) — proceed best-effort.

  return new Promise<boolean>((resolve) => {
    locksApi.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        resolve(false);
        return;
      }
      resolve(true);
      // Hold the lock for the worker's entire lifetime.
      await new Promise<void>(() => { /* never resolves; released when the worker/tab closes */ });
    }).catch(() => resolve(true));
  });
}

async function init(): Promise<InitResult> {
  const crossOriginIsolated = (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!crossOriginIsolated) {
    return { crossOriginIsolated: false, locked: false, hasData: false };
  }

  const acquired = await acquireLockOrReportLocked();
  if (!acquired) {
    locked = true;
    return { crossOriginIsolated: true, locked: true, hasData: false };
  }

  const sqlite3 = await sqlite3InitModule();
  const poolUtility = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
  db = new poolUtility.OpfsSAHPoolDb(DB_FILE) as unknown as SqliteDb;

  for (const stmt of CONNECTION_PRAGMAS_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    db.exec(stmt);
  }
  db.exec(CREATE_SCHEMA_SQL);
  db.exec(CREATE_INDEXES_SQL);

  return { crossOriginIsolated: true, locked: false, hasData: scalarCount('SELECT COUNT(*) as c FROM messages') > 0 };
}

function isMigrated(): boolean {
  const rows = db!.selectObjects('SELECT value FROM meta WHERE key = ?', [MIGRATION_META_KEY]);
  return rows.length > 0 && rows[0]!.value === '1';
}

function markMigrated(): void {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [MIGRATION_META_KEY, '1']);
}

/**
 * One-time IndexedDB -> SQLite migration. Idempotent: no-ops if already
 * migrated, or if the SQLite table already has rows (never overwrites).
 * Runs entirely inside this worker (IndexedDB is available in workers) so no
 * message data has to cross a second postMessage hop.
 */
async function migrateFromIndexedDb(): Promise<{ migrated: boolean; count: number }> {
  if (!db) throw new Error('migrateFromIndexedDb called before init');
  if (isMigrated()) return { migrated: false, count: 0 };

  const existing = scalarCount('SELECT COUNT(*) as c FROM messages');
  if (existing > 0) {
    markMigrated();
    return { migrated: false, count: existing };
  }

  interface LegacyDexieDatabase {
    messages: {
      count(): Promise<number>;
      where(key: string): { above(value: number): { limit(n: number): { toArray(): Promise<unknown[]> } } };
      limit(n: number): { toArray(): Promise<unknown[]> };
    };
    participants: { toArray(): Promise<ChatParticipant[]> };
  }
  const { database } = await import('@/core/database/schema') as unknown as { database: LegacyDexieDatabase };

  const total = await database.messages.count();
  if (total === 0) {
    markMigrated();
    return { migrated: false, count: 0 };
  }

  const CHUNK = 5000;
  let processed = 0;
  let lastId: number | undefined;

  db.exec('BEGIN');
  try {
    while (processed < total) {
      const chunk = (lastId === undefined
        ? await database.messages.limit(CHUNK).toArray()
        : await database.messages.where('id').above(lastId).limit(CHUNK).toArray()) as ChatMessage[];
      if (chunk.length === 0) break;

      const stmt = db.prepare(
        'INSERT INTO messages (id,type,timestamp,date_key,hour,day_of_week,from_id,from_name,text,text_length,service_action,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const message of chunk) {
        stmt.bind(messageToRow(message));
        stmt.step();
        stmt.reset();
      }
      stmt.finalize();

      processed += chunk.length;
      lastId = chunk.at(-1)?.id;
      post({ kind: 'push', event: 'migrationProgress', data: { phase: 'writing', processed, total } satisfies MigrationProgress });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  post({ kind: 'push', event: 'migrationProgress', data: { phase: 'indexing', processed: total, total } });

  const participants = await database.participants.toArray();
  if (participants.length > 0) {
    const stmt = db.prepare('INSERT OR REPLACE INTO participants (id,name,color,is_me) VALUES (?,?,?,?)');
    for (const p of participants) {
      stmt.bind(participantToRow(p));
      stmt.step();
      stmt.reset();
    }
    stmt.finalize();
  }

  markMigrated();
  post({ kind: 'push', event: 'migrationProgress', data: { phase: 'done', processed: total, total } });
  return { migrated: true, count: total };
}

function fetchPage(params: FetchPageParams): FetchPageResult {
  const sort = resolveSort(params.filter.sortBy);
  const { sql, params: sqlParams } = buildFetchPageQuery(params.filter, sort, params.cursor, params.limit);
  const rows = db!.selectObjects(sql, sqlParams) as unknown as MessageRow[];
  const items = rows.map((row) => rowToMessage(row));
  const last = rows.at(-1);
  const nextCursor: Cursor | undefined = last
    ? { sortValue: (last as unknown as Record<string, unknown>)[sort.column] as number | string, id: last.id }
    : undefined;
  return { items, nextCursor: rows.length === params.limit ? nextCursor : undefined };
}

function count(filter: FetchPageParams['filter']): number {
  const { sql, params } = buildCountQuery(filter);
  const [row] = db!.selectObjects(sql, params);
  return row!.c as number;
}

/**
 * Resolves the boundary cursor immediately BEFORE absolute row `rank` in the
 * filtered+sorted set — used only when the virtual scroller jumps to an index
 * with no adjacent cached page (e.g. dragging the scrollbar far from the
 * current position). Exact for 0-1 active types; best-effort for 2+ (see
 * queryBuilder.ts's pickBranchForApproximateRank doc comment).
 */
function resolveRank(params: ResolveRankParams): ResolveRankResult {
  const sort = resolveSort(params.filter.sortBy);
  const filterType = params.filter.type;
  let types: string[] | undefined;
  if (filterType) {
    types = Array.isArray(filterType) ? filterType : [filterType];
  }

  if (!types || types.length <= 1) {
    if (params.rank <= 0) return { cursorBefore: undefined, exact: true };
    const { sql, params: sqlParams } = buildExactRankSeekQuery(params.filter, sort, params.rank - 1);
    const rows = db!.selectObjects(sql, sqlParams);
    if (rows.length === 0) return { cursorBefore: undefined, exact: true };
    const row = rows[0]!;
    return { cursorBefore: { sortValue: row.sort_value as number | string, id: row.id as number }, exact: true };
  }

  const perTypeCounts = types.map((type) => {
    const { sql, params: sqlParams } = buildPerTypeCountQuery(type, params.filter);
    const [row] = db!.selectObjects(sql, sqlParams);
    return { type, count: row!.c as number };
  });
  const picked = pickBranchForApproximateRank(perTypeCounts, Math.max(params.rank - 1, 0));
  if (!picked) return { cursorBefore: undefined, exact: true };

  const { sql, params: sqlParams } = buildExactRankSeekQuery(
    { ...params.filter, type: picked.type as FetchPageParams['filter']['type'] },
    sort,
    picked.localOffset,
  );
  const rows = db!.selectObjects(sql, sqlParams);
  if (rows.length === 0) return { cursorBefore: undefined, exact: false };
  const row = rows[0]!;
  return { cursorBefore: { sortValue: row.sort_value as number | string, id: row.id as number }, exact: false };
}

function saveMessages(params: SaveMessagesParams): void {
  if (params.mode === 'replace') {
    db!.exec('DELETE FROM messages');
  }
  db!.exec('BEGIN');
  try {
    const stmt = db!.prepare(
      'INSERT OR REPLACE INTO messages (id,type,timestamp,date_key,hour,day_of_week,from_id,from_name,text,text_length,service_action,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const message of params.messages) {
      stmt.bind(messageToRow(message));
      stmt.step();
      stmt.reset();
    }
    stmt.finalize();
    db!.exec('COMMIT');
  } catch (error) {
    db!.exec('ROLLBACK');
    throw error;
  }
}

function removeLastMessages(count_: number): number {
  const rows = db!.selectObjects('SELECT id FROM messages ORDER BY id DESC LIMIT ?', [count_]);
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id as number);
  run(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  return ids.length;
}

function loadParticipants(): ChatParticipant[] {
  const rows = db!.selectObjects('SELECT * FROM participants') as unknown as { id: string; name: string; color: string | null; is_me: number }[];
  return rows.map((row) => rowToParticipant(row));
}

function saveParticipants(participants: ChatParticipant[]): void {
  db!.exec('DELETE FROM participants');
  const stmt = db!.prepare('INSERT INTO participants (id,name,color,is_me) VALUES (?,?,?,?)');
  for (const p of participants) {
    stmt.bind(participantToRow(p));
    stmt.step();
    stmt.reset();
  }
  stmt.finalize();
}

function clear(): void {
  db!.exec('DELETE FROM messages; DELETE FROM participants; DELETE FROM meta;');
}

function hasData(): boolean {
  return scalarCount('SELECT COUNT(*) as c FROM messages') > 0;
}

let bulkWriteDepth = 0;

/**
 * Drops the secondary indexes for the duration of a bulk-write session (a
 * fresh file import or mock-data generation run arriving as many
 * appendMessages chunks) — see DROP_INDEXES_SQL's doc comment for the
 * measured cost this avoids. Reentrant: nested begin/end pairs (e.g. a
 * caller that itself wraps several finer-grained sessions) only drop once
 * and only rebuild once, on the outermost end.
 */
function beginBulkWrite(): void {
  bulkWriteDepth++;
  if (bulkWriteDepth > 1) return;
  db!.exec(DROP_INDEXES_SQL);
}

function endBulkWrite(): void {
  bulkWriteDepth = Math.max(bulkWriteDepth - 1, 0);
  if (bulkWriteDepth > 0) return;
  db!.exec(CREATE_INDEXES_SQL);
  db!.exec('ANALYZE;');
}

// ---------------------------------------------------------------------------
// Analytics (replaces the Dexie materialized-view tables with GROUP BY)
// ---------------------------------------------------------------------------

function analyticsTopSenders(params: AnalyticsTopSendersParams): SenderCount[] {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (params.filter?.types && params.filter.types.length > 0) {
    clauses.push(`type IN (${params.filter.types.map(() => '?').join(',')})`);
    values.push(...params.filter.types);
  }
  if (params.filter?.dateRange) {
    clauses.push('timestamp >= ? AND timestamp <= ?');
    values.push(params.filter.dateRange.start.getTime(), params.filter.dateRange.end.getTime());
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = params.limit ?? 20;
  const rows = db!.selectObjects(
    `SELECT from_id, from_name, COUNT(*) as c FROM messages ${where} GROUP BY from_id ORDER BY c DESC LIMIT ?`,
    [...values, limit],
  );
  return rows.map((r) => ({ senderId: r.from_id as string, senderName: r.from_name as string, count: r.c as number }));
}

function dateRangeClause(dateRange?: { start: Date; end: Date }): { clause: string; values: number[] } {
  if (!dateRange) return { clause: '', values: [] };
  return {
    clause: 'WHERE date_key >= ? AND date_key <= ?',
    values: [isoDateToDateKey(dateRange.start.toISOString().slice(0, 10)), isoDateToDateKey(dateRange.end.toISOString().slice(0, 10))],
  };
}

function analyticsDailyVolume(params: AnalyticsDateRangeParams): DailyVolumePoint[] {
  const { clause, values } = dateRangeClause(params.dateRange);
  const rows = db!.selectObjects(`SELECT date_key, COUNT(*) as c FROM messages ${clause} GROUP BY date_key ORDER BY date_key ASC`, values);
  return rows.map((r) => {
    const dk = r.date_key as number;
    const year = Math.floor(dk / 10_000);
    const month = Math.floor((dk % 10_000) / 100) - 1;
    const day = dk % 100;
    return { date: new Date(year, month, day), count: r.c as number };
  });
}

function analyticsHeatmap(params: AnalyticsDateRangeParams): HeatmapPoint[] {
  const { clause, values } = dateRangeClause(params.dateRange);
  const rows = db!.selectObjects(
    `SELECT day_of_week, hour, COUNT(*) as c FROM messages ${clause} GROUP BY day_of_week, hour`,
    values,
  );
  return rows.map((r) => ({ dayOfWeek: r.day_of_week as number, hour: r.hour as number, count: r.c as number }));
}

function analyticsTimeOfDay(params: AnalyticsDateRangeParams): TimeSlotCount[] {
  const { clause, values } = dateRangeClause(params.dateRange);
  const rows = db!.selectObjects(`SELECT hour, COUNT(*) as c FROM messages ${clause} GROUP BY hour`, values);
  const slots: Record<TimeSlotCount['slot'], number> = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const r of rows) {
    slots[getTimeSlot(r.hour as number)] += r.c as number;
  }
  return (['morning', 'afternoon', 'evening', 'night'] as const).map((slot) => ({ slot, count: slots[slot] }));
}

// ---------------------------------------------------------------------------
// Phone calls (type='service' AND service_action='phone_call')
// ---------------------------------------------------------------------------

function loadCalls(params: LoadCallsParams): PhoneCall[] {
  const clauses = ["type = 'service'", "service_action = 'phone_call'"];
  const values: (string | number)[] = [];
  if (params.dateRange) {
    clauses.push('date_key >= ? AND date_key <= ?');
    values.push(isoDateToDateKey(params.dateRange.start), isoDateToDateKey(params.dateRange.end));
  }
  const rows = db!.selectObjects(`SELECT * FROM messages WHERE ${clauses.join(' AND ')}`, values) as unknown as MessageRow[];
  return rows.map((row) => {
    const message = rowToMessage(row);
    return {
      id: message.id,
      date: message.timestamp.toISOString(),
      dateUnixtime: Math.floor(message.timestamp.getTime() / 1000).toString(),
      actor: message.from,
      actorId: message.fromId,
      discardReason: (message.discardReason as PhoneCall['discardReason']) ?? 'hangup',
      durationSeconds: message.file?.duration,
    };
  });
}

function getCallCount(): number {
  return scalarCount("SELECT COUNT(*) as c FROM messages WHERE type = 'service' AND service_action = 'phone_call'");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const handlers: Record<string, (params: never) => unknown | Promise<unknown>> = {
  init,
  migrateFromIndexedDb,
  fetchPage,
  count,
  resolveRank,
  saveMessages,
  appendMessages: (params: SaveMessagesParams) => saveMessages({ ...params, mode: 'append' }),
  removeLastMessages: (params: { count: number }) => removeLastMessages(params.count),
  loadParticipants,
  saveParticipants: (params: { participants: ChatParticipant[] }) => saveParticipants(params.participants),
  clear,
  hasData,
  beginBulkWrite,
  endBulkWrite,
  analyticsTopSenders,
  analyticsDailyVolume,
  analyticsHeatmap,
  analyticsTimeOfDay,
  loadCalls,
  getCallCount,
};

globalThis.addEventListener('message', (event: MessageEvent<WorkerRequestEnvelope>) => {
  const { id, method, params } = event.data;
  const handler = handlers[method];
  if (!handler) {
    post({ kind: 'response', id, error: `Unknown method: ${method}` });
    return;
  }
  if (locked && method !== 'init') {
    post({ kind: 'response', id, error: 'Database is locked by another tab' });
    return;
  }

  Promise.resolve()
    .then(() => handler(params as never))
    .then((result) => post({ kind: 'response', id, result }))
    .catch((error: unknown) => post({ kind: 'response', id, error: error instanceof Error ? error.message : String(error) }));
});
