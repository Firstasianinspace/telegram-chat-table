import { describe, it, expect, beforeAll } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  buildCountQuery,
  buildFetchPageQuery,
  buildExactRankSeekQuery,
  buildPerTypeCountQuery,
  pickBranchForApproximateRank,
  resolveSort,
} from './queryBuilder';
import { CREATE_SCHEMA_SQL, CREATE_INDEXES_SQL, computeDerivedFields } from './schema';
import type { MessageQueryParameters, Cursor } from '../../domain/interfaces/IChatRepository';

// Runs against a REAL SQLite engine (the Node build of @sqlite.org/sqlite-wasm,
// in-memory, no OPFS) so these tests catch actual SQL/planner mistakes, not
// just "the string looks right".

interface Db {
  exec(sql: string): void;
  selectObjects(sql: string, params?: unknown[]): Record<string, unknown>[];
}

let db: Db;

const TYPES = ['text', 'sticker', 'photo', 'video', 'audio', 'voice', 'animation', 'service'];

function seed(n: number): void {
  db.exec('DELETE FROM messages;');
  const baseTs = Date.parse('2024-01-01T00:00:00Z');
  let x = 12_345;
  const rnd = (): number => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4_294_967_296;
  };
  db.exec('BEGIN');
  for (let index = 1; index <= n; index++) {
    const type = TYPES[Math.floor(rnd() * TYPES.length)]!;
    const ts = baseTs + Math.floor(rnd() * 90 * 24 * 3600 * 1000);
    const senderIndex = Math.floor(rnd() * 12);
    const fromId = `user${senderIndex}`;
    const fromName = `User ${senderIndex}`;
    const textLength = type === 'text' ? Math.floor(rnd() * 50) : 0;
    const { dateKey, hour, dayOfWeek } = computeDerivedFields(ts);
    // eslint-disable-next-line unicorn/no-null -- SQL NULL columns (service_action, extra; and text when empty)
    const textValue = textLength > 0 ? 'x'.repeat(textLength) : null;
    db.selectObjects(
      'INSERT INTO messages (id,type,timestamp,date_key,hour,day_of_week,from_id,from_name,text,text_length,service_action,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      // eslint-disable-next-line unicorn/no-null -- SQL NULL
      [index, type, ts, dateKey, hour, dayOfWeek, fromId, fromName, textValue, textLength, null, null],
    );
  }
  db.exec('COMMIT');
}

beforeAll(async () => {
  const sqlite3 = await sqlite3InitModule();
  const raw = new sqlite3.oo1.DB(':memory:', 'c');
  db = raw as unknown as Db;
  db.exec(CREATE_SCHEMA_SQL);
  db.exec(CREATE_INDEXES_SQL);
});

function compareValues(a: number | string, b: number | string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Reference implementation: sort+filter entirely in JS, used as ground truth. */
function bruteForceOrder(
  rows: Record<string, unknown>[],
  params: Omit<MessageQueryParameters, 'offset' | 'limit'>,
): Record<string, unknown>[] {
  let types: (string | undefined)[] | undefined;
  if (params.type) {
    types = Array.isArray(params.type) ? params.type : [params.type];
  }
  let filtered = rows.filter((r) => {
    if (types && !(types as string[]).includes(r.type as string)) return false;
    if (params.fromId && r.from_id !== params.fromId) return false;
    if (params.dateFrom && (r.timestamp as number) < params.dateFrom.getTime()) return false;
    if (params.dateTo && (r.timestamp as number) > params.dateTo.getTime()) return false;
    if (params.searchText) {
      const s = params.searchText.toLowerCase();
      const text = (r.text as string | null)?.toLowerCase() ?? '';
      const name = (r.from_name as string).toLowerCase();
      if (!text.includes(s) && !name.includes(s)) return false;
    }
    return true;
  });
  const sort = resolveSort(params.sortBy);
  filtered = filtered.toSorted((a, b) => {
    const av = a[sort.column] as number | string;
    const bv = b[sort.column] as number | string;
    const cmp = compareValues(av, bv) || (a.id as number) - (b.id as number);
    return sort.desc ? -cmp : cmp;
  });
  return filtered;
}

describe('queryBuilder against a real SQLite engine', () => {
  const N = 5000;
  let allRows: Record<string, unknown>[];

  beforeAll(() => {
    seed(N);
    allRows = db.selectObjects('SELECT * FROM messages');
  });

  const cases: Omit<MessageQueryParameters, 'offset' | 'limit'>[] = [
    {},
    { type: 'text' },
    { type: ['text', 'voice', 'photo'] },
    { type: ['text', 'voice'], sortBy: [{ field: 'from', direction: 'asc' }] },
    { sortBy: [{ field: 'timestamp', direction: 'asc' }] },
    { sortBy: [{ field: 'from', direction: 'desc' }] },
    { sortBy: [{ field: 'length', direction: 'desc' }] },
    { sortBy: [{ field: 'id', direction: 'asc' }] },
    { sortBy: [{ field: 'type', direction: 'asc' }] },
    { sortBy: [{ field: 'type', direction: 'desc' }] },
    { type: ['text', 'voice'], sortBy: [{ field: 'type', direction: 'asc' }] },
    { type: ['sticker', 'video', 'audio'], sortBy: [{ field: 'length', direction: 'asc' }] },
    { fromId: 'user3', sortBy: [{ field: 'timestamp', direction: 'desc' }] },
    { dateFrom: new Date('2024-01-15'), dateTo: new Date('2024-02-15') },
    { searchText: 'x' },
  ];

  it.each(cases)('count matches ground truth for %j', (params) => {
    const { sql, params: sqlParams } = buildCountQuery(params);
    const [row] = db.selectObjects(sql, sqlParams);
    const expected = bruteForceOrder(allRows, params).length;
    expect(row!.c).toBe(expected);
  });

  it.each(cases)('keyset pagination reproduces the full ground-truth order for %j', (params) => {
    const expected = bruteForceOrder(allRows, params);
    const sort = resolveSort(params.sortBy);
    const pageSize = 37; // deliberately not a divisor of N, to exercise the last partial page
    const collected: Record<string, unknown>[] = [];
    let cursor: Cursor | undefined;

    for (let guard = 0; guard < Math.ceil(N / pageSize) + 5; guard++) {
      const { sql, params: sqlParams } = buildFetchPageQuery(params, sort, cursor, pageSize);
      const page = db.selectObjects(sql, sqlParams);
      if (page.length === 0) break;
      collected.push(...page);
      const last = page.at(-1)!;
      cursor = { sortValue: last[sort.column] as number | string, id: last.id as number };
    }

    expect(collected.map((r) => r.id)).toEqual(expected.map((r) => r.id));
  });

  it('exact rank-seek matches ground truth for single-type filters', () => {
    const params: Omit<MessageQueryParameters, 'offset' | 'limit'> = {
      type: 'text',
      sortBy: [{ field: 'timestamp', direction: 'desc' }],
    };
    const expected = bruteForceOrder(allRows, params);
    const sort = resolveSort(params.sortBy);

    for (const rank of [0, 1, 10, Math.floor(expected.length / 2), expected.length - 1]) {
      const { sql, params: sqlParams } = buildExactRankSeekQuery(params, sort, rank);
      const [row] = db.selectObjects(sql, sqlParams);
      expect(row!.id).toBe(expected[rank]!.id);
    }
  });

  it('exact rank-seek matches ground truth for no filter', () => {
    const params: Omit<MessageQueryParameters, 'offset' | 'limit'> = {
      sortBy: [{ field: 'from', direction: 'asc' }],
    };
    const expected = bruteForceOrder(allRows, params);
    const sort = resolveSort(params.sortBy);
    const rank = 1234;
    const { sql, params: sqlParams } = buildExactRankSeekQuery(params, sort, rank);
    const [row] = db.selectObjects(sql, sqlParams);
    expect(row!.id).toBe(expected[rank]!.id);
  });

  it('approximate multi-type rank-seek lands on a real, correctly-filtered row', () => {
    const params: Omit<MessageQueryParameters, 'offset' | 'limit'> = {
      type: ['text', 'voice', 'photo'],
      sortBy: [{ field: 'timestamp', direction: 'desc' }],
    };
    const perTypeCounts = (params.type as string[]).map((type) => {
      const { sql, params: p } = buildPerTypeCountQuery(type, params);
      const [row] = db.selectObjects(sql, p);
      return { type, count: row!.c as number };
    });
    const target = Math.floor(perTypeCounts.reduce((s, t) => s + t.count, 0) / 2);
    const picked = pickBranchForApproximateRank(perTypeCounts, target);
    expect(picked).toBeDefined();

    const sort = resolveSort(params.sortBy);
    const { sql, params: p } = buildExactRankSeekQuery(
      { type: picked!.type as MessageQueryParameters['type'], sortBy: params.sortBy },
      sort,
      picked!.localOffset,
    );
    const [row] = db.selectObjects(sql, p);
    expect(row).toBeDefined();

    // The landing row must genuinely belong to the filtered type set.
    const [full] = db.selectObjects('SELECT type FROM messages WHERE id = ?', [row!.id as number]);
    expect((params.type as string[])).toContain(full!.type);
  });
});
