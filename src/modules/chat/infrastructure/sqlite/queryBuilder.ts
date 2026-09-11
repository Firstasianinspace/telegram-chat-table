/**
 * Pure SQL builders for the SQLite message store. No DB handle is touched
 * here — every function returns `{ sql, params }` so it can be unit-tested
 * against a real SQLite engine (see queryBuilder.test.ts, which runs against
 * the Node build of @sqlite.org/sqlite-wasm) without any browser/OPFS
 * machinery.
 *
 * Two hard-won rules, both measured on a 1M-row prototype (see
 * ENTERPRISE_TABLE_ARCHITECTURE.md), drive every query built here:
 *
 * 1. Tie-break direction must match the primary sort direction (DESC sort ->
 *    id DESC, ASC sort -> id ASC). Since `id` is the SQLite rowid, a single
 *    index scan already returns ties in rowid order "for free" — but only if
 *    the requested tie-break direction agrees with the scan direction.
 *    Mismatched tie-break forces a full temp-b-tree sort (~160x slower).
 * 2. `LIMIT n OFFSET m` is only cheap when the query can be served by a
 *    single ordered index scan (no filter, or a single equality filter).
 *    A multi-value filter (`type IN (...)`) forces a temp b-tree merge, and
 *    OFFSET on top of that forces materializing every one of the first
 *    `m + n` matching rows (measured ~18.7s at offset 200,000 on 1M rows).
 *    The fix used everywhere below: never use OFFSET for a multi-value
 *    filter. Instead, run one bounded (`LIMIT n`, no OFFSET) keyset query per
 *    filter value and merge the small results — each branch uses its own
 *    index and stops after `n` rows (measured ~15ms for the same query that
 *    took 18.7s with OFFSET).
 */

import type { MessageQueryParameters, Cursor } from '../../domain/interfaces/IChatRepository';

export type SqlColumn = 'timestamp' | 'from_name' | 'text_length' | 'id' | 'type';

export interface ResolvedSort {
  column: SqlColumn;
  desc: boolean;
}

export interface SqlParams {
  sql: string;
  params: (string | number)[];
}

/** Only these SortFields are backed by a dedicated index (see schema.ts / the query matrix
 * in ENTERPRISE_TABLE_ARCHITECTURE.md) — every other SortField the type allows (nested file.*
 * columns) is not exposed as sortable in tableColumns.ts, so it is not supported here. */
export function resolveSort(sortBy: MessageQueryParameters['sortBy']): ResolvedSort {
  const primary = sortBy?.[0];
  const field = primary?.field ?? 'timestamp';
  const desc = (primary?.direction ?? 'desc') === 'desc';

  if (field === 'id') return { column: 'id', desc };
  if (field === 'from') return { column: 'from_name', desc };
  if (field === 'length') return { column: 'text_length', desc };
  if (field === 'type') return { column: 'type', desc };
  // 'timestamp' and any unsupported field both fall back to timestamp, matching
  // the pre-migration default behavior for fields the table never actually sorts by.
  return { column: 'timestamp', desc };
}

function normalizeTypes(type: MessageQueryParameters['type']): string[] | undefined {
  if (!type) return undefined;
  const values = Array.isArray(type) ? type : [type];
  return values.length > 0 ? values : undefined;
}

interface BaseFilter {
  fromId?: string;
  dateFromMs?: number;
  dateToMs?: number;
  searchText?: string;
}

function buildBaseFilter(params: Omit<MessageQueryParameters, 'offset' | 'limit'>): BaseFilter {
  return {
    fromId: params.fromId,
    dateFromMs: params.dateFrom ? params.dateFrom.getTime() : undefined,
    dateToMs: params.dateTo ? params.dateTo.getTime() : undefined,
    searchText: params.searchText,
  };
}

/** WHERE clauses shared by every branch, excluding `type` (handled by the caller). */
function buildNonTypeWhere(base: BaseFilter): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const values: (string | number)[] = [];

  if (base.fromId) {
    clauses.push('from_id = ?');
    values.push(base.fromId);
  }
  if (base.dateFromMs !== undefined) {
    clauses.push('timestamp >= ?');
    values.push(base.dateFromMs);
  }
  if (base.dateToMs !== undefined) {
    clauses.push('timestamp <= ?');
    values.push(base.dateToMs);
  }
  if (base.searchText) {
    clauses.push('(text LIKE ? OR from_name LIKE ?)');
    const pattern = `%${base.searchText}%`;
    values.push(pattern, pattern);
  }

  return { clauses, params: values };
}

/** Tie-break-direction-matched cursor predicate: `(col, id) < (v, id)` for DESC, `>` for ASC. */
function buildCursorPredicate(column: SqlColumn, desc: boolean, cursor: Cursor): { clause: string; params: (string | number)[] } {
  const op = desc ? '<' : '>';
  return {
    clause: `(${column} ${op} ? OR (${column} = ? AND id ${op} ?))`,
    params: [cursor.sortValue, cursor.sortValue, cursor.id],
  };
}

const COLUMNS_SELECT = 'id, type, timestamp, date_key, hour, day_of_week, from_id, from_name, text, text_length, service_action, extra';

/**
 * Build the count query. Safe to use `type IN (...)` directly — COUNT has no
 * ORDER BY, so there is no temp-b-tree risk regardless of how many types are
 * requested (measured ~100ms for a 3-type IN() count on 1M rows).
 */
export function buildCountQuery(params: Omit<MessageQueryParameters, 'offset' | 'limit'>): SqlParams {
  const types = normalizeTypes(params.type);
  const base = buildBaseFilter(params);
  const { clauses, params: values } = buildNonTypeWhere(base);

  if (types && types.length > 0) {
    clauses.unshift(`type IN (${types.map(() => '?').join(',')})`);
    values.unshift(...types);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return { sql: `SELECT COUNT(*) as c FROM messages ${where}`, params: values };
}

/**
 * Build a keyset (cursor) page fetch: the workhorse for every scroll step.
 * `cursor` undefined means "first page". Never uses OFFSET.
 */
export function buildFetchPageQuery(
  params: Omit<MessageQueryParameters, 'offset' | 'limit'>,
  sort: ResolvedSort,
  cursor: Cursor | undefined,
  limit: number,
): SqlParams {
  const types = normalizeTypes(params.type);
  const base = buildBaseFilter(params);
  const direction = sort.desc ? 'DESC' : 'ASC';

  const buildBranch = (type: string | undefined): SqlParams => {
    const { clauses, params: values } = buildNonTypeWhere(base);
    if (type) {
      clauses.unshift('type = ?');
      values.unshift(type);
    }
    if (cursor) {
      const { clause, params: cursorParams } = buildCursorPredicate(sort.column, sort.desc, cursor);
      clauses.push(clause);
      values.push(...cursorParams);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return {
      sql: `SELECT ${COLUMNS_SELECT} FROM messages ${where} ORDER BY ${sort.column} ${direction}, id ${direction} LIMIT ?`,
      params: [...values, limit],
    };
  };

  if (!types || types.length <= 1) {
    return buildBranch(types?.[0]);
  }

  // Multi-type: one bounded (LIMIT, no OFFSET) subquery per type, merged.
  const branches = types.map((t) => buildBranch(t));
  const unionSql = branches.map((b) => `SELECT * FROM (${b.sql})`).join(' UNION ALL ');
  const allParams = branches.flatMap((b) => b.params);
  return {
    sql: `SELECT * FROM (${unionSql}) ORDER BY ${sort.column} ${direction}, id ${direction} LIMIT ?`,
    params: [...allParams, limit],
  };
}

/**
 * Per-type row count, used by the rank-seek estimator below and by call-site
 * heuristics that decide whether a filter change needs a seed step at all.
 */
export function buildPerTypeCountQuery(
  type: string,
  params: Omit<MessageQueryParameters, 'offset' | 'limit'>,
): SqlParams {
  const base = buildBaseFilter(params);
  const { clauses, params: values } = buildNonTypeWhere(base);
  clauses.unshift('type = ?');
  values.unshift(type);
  return { sql: `SELECT COUNT(*) as c FROM messages WHERE ${clauses.join(' AND ')}`, params: values };
}

/**
 * Exact rank-seek for 0 or 1 active type filters: a single ordered index scan
 * with OFFSET, which early-terminates at the index level and stays cheap even
 * at very deep offsets (measured 28-185ms at offset 400,000 on 1M rows) — no
 * temp b-tree is involved because there is only one branch to order.
 */
export function buildExactRankSeekQuery(
  params: Omit<MessageQueryParameters, 'offset' | 'limit'>,
  sort: ResolvedSort,
  rank: number,
): SqlParams {
  const types = normalizeTypes(params.type);
  const base = buildBaseFilter(params);
  const { clauses, params: values } = buildNonTypeWhere(base);
  if (types && types.length === 1) {
    clauses.unshift('type = ?');
    values.unshift(types[0]!);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const direction = sort.desc ? 'DESC' : 'ASC';
  return {
    sql: `SELECT ${sort.column} as sort_value, id FROM messages ${where} ORDER BY ${sort.column} ${direction}, id ${direction} LIMIT 1 OFFSET ?`,
    params: [...values, rank],
  };
}

/**
 * Best-effort rank-seek for 2+ active type filters: proportionally distributes
 * `rank` across types (weighted by each type's own indexed count, itself
 * cheap), then reads the boundary row at that local offset from ONE type
 * branch via the same cheap single-type-OFFSET path as buildExactRankSeekQuery.
 *
 * This intentionally does not attempt exact global rank across the merged
 * multi-type order — doing so exactly would require re-introducing the
 * O(matches) seed-map scan this migration removes. What it guarantees: the
 * landing row is a real row from the filtered+sorted set, within roughly one
 * type's local neighborhood of the requested position, resolved in a handful
 * of cheap indexed queries regardless of table size. See "Known limitation:
 * scrollbar jump under a multi-type filter" in ENTERPRISE_TABLE_ARCHITECTURE.md.
 */
export function pickBranchForApproximateRank(
  perTypeCounts: { type: string; count: number }[],
  rank: number,
): { type: string; localOffset: number } | undefined {
  const total = perTypeCounts.reduce((s, t) => s + t.count, 0);
  if (total === 0) return undefined;

  const clampedRank = Math.min(Math.max(rank, 0), total - 1);
  let remaining = clampedRank;
  for (const { type, count } of perTypeCounts) {
    if (count === 0) continue;
    const share = Math.round((count / total) * clampedRank);
    const localOffset = Math.min(share, count - 1);
    if (remaining <= count) {
      return { type, localOffset };
    }
    remaining -= count;
  }
  // Fallback: land in the last non-empty branch.
  const last = [...perTypeCounts].toReversed().find((t) => t.count > 0);
  return last ? { type: last.type, localOffset: Math.max(last.count - 1, 0) } : undefined;
}
