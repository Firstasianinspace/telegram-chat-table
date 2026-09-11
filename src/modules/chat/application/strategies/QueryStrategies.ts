/**
 * Strategy Pattern (GoF) for Query Execution.
 *
 * `QueryStrategy` is cursor-based (keyset pagination): `fetchPage` takes an
 * optional `Cursor` (the last row of the previous page) instead of an
 * offset. This is what makes filter/sort changes stay fast at 1M rows — see
 * queryBuilder.ts for why OFFSET-based paging isn't an option for a
 * multi-value filter.
 *
 * Two implementations:
 * - `SqliteQueryStrategy` — the primary path, backed by sqlite.worker.ts.
 * - `LegacyIndexedDbQueryStrategy` — an adapter that gives IndexedDBChatRepository's
 *   existing (unmodified) seed-map machinery the same cursor-based interface,
 *   used only as the fallback for environments without cross-origin isolation
 *   (see chatStorageBootstrap.ts). It is intentionally simpler and slower —
 *   it inherits the old 200,000-row verified scope, not the new 1,000,000.
 */

import type { ChatMessage } from '../../domain/entities/types';
import type { MessageQueryParameters, PaginatedResult, Cursor, SortField } from '../../domain/interfaces/IChatRepository';
import { acquireWorkerSession, type WorkerSessionLease } from './workerSessionManager';
import type { SqliteWorkerClient } from '../../infrastructure/sqlite/sqliteWorkerClient';

export const WORKER_QUERY_ROW_THRESHOLD = 500;
export const WORKER_QUERY_TIMEOUT_MS = 30_000;

export interface FetchPageParams {
  filter: Omit<MessageQueryParameters, 'offset' | 'limit'>;
  cursor: Cursor | undefined;
  limit: number;
}

export interface FetchPageResult {
  items: ChatMessage[];
  nextCursor: Cursor | undefined;
}

export interface ResolveRankResult {
  cursorBefore: Cursor | undefined;
  /** false when the multi-type approximate rank-seek path was used — see queryBuilder.ts. */
  exact: boolean;
}

export interface QueryStrategy {
  fetchPage(params: FetchPageParams): Promise<FetchPageResult>;
  count(filter: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number>;
  /** Resolves the cursor immediately BEFORE absolute row `rank` — used only for cold jumps (see VirtualTableDataProxy). */
  resolveRank(filter: Omit<MessageQueryParameters, 'offset' | 'limit'>, rank: number): Promise<ResolveRankResult>;
}

// ---------------------------------------------------------------------------
// Primary: SQLite (via sqlite.worker.ts)
// ---------------------------------------------------------------------------

export class SqliteQueryStrategy implements QueryStrategy {
  constructor(private readonly client: SqliteWorkerClient) { }

  async fetchPage(params: FetchPageParams): Promise<FetchPageResult> {
    return this.client.fetchPage(params);
  }

  async count(filter: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number> {
    return this.client.count(filter);
  }

  async resolveRank(filter: Omit<MessageQueryParameters, 'offset' | 'limit'>, rank: number): Promise<ResolveRankResult> {
    return this.client.resolveRank({ filter, rank });
  }
}

// ---------------------------------------------------------------------------
// Legacy: IndexedDB (fallback for non-cross-origin-isolated environments)
// ---------------------------------------------------------------------------

/**
 * Old query execution split, unchanged from the pre-SQLite architecture.
 * Kept only so LegacyIndexedDbQueryStrategy can drive it — nothing else
 * should depend on this interface going forward.
 */
export interface LegacyQueryStrategy {
  executeQuery(parameters: MessageQueryParameters): Promise<PaginatedResult<ChatMessage>>;
  executeCount(parameters: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number>;
  canHandle(parameters: MessageQueryParameters): boolean;
  buildPageSeedMap(
    parameters: Omit<MessageQueryParameters, 'offset' | 'limit' | 'pageKeys'>,
    pageSize: number,
  ): Promise<number[]>;
}

export class IndexedDBQueryStrategy implements LegacyQueryStrategy {
  constructor(
    private readonly queryExecutor: (parameters: MessageQueryParameters) => Promise<PaginatedResult<ChatMessage>>,
    private readonly countExecutor: (parameters: Omit<MessageQueryParameters, 'offset' | 'limit'>) => Promise<number>,
    private readonly seedMapExecutor: (
      parameters: Omit<MessageQueryParameters, 'offset' | 'limit' | 'pageKeys'>,
      pageSize: number,
    ) => Promise<number[]>,
  ) { }

  async executeQuery(parameters: MessageQueryParameters): Promise<PaginatedResult<ChatMessage>> {
    return this.queryExecutor(parameters);
  }

  async executeCount(parameters: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number> {
    return this.countExecutor(parameters);
  }

  async buildPageSeedMap(
    parameters: Omit<MessageQueryParameters, 'offset' | 'limit' | 'pageKeys'>,
    pageSize: number,
  ): Promise<number[]> {
    return this.seedMapExecutor(parameters, pageSize);
  }

  canHandle(_parameters: MessageQueryParameters): boolean {
    return true;
  }
}

export class WorkerQueryStrategy implements LegacyQueryStrategy {
  private readonly workerSession: WorkerSessionLease;
  private attachedWorker: Worker | undefined = undefined;
  private messageId = 0;
  private pendingQueries = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
    settled: boolean;
  }>();

  /**
   * `createWorker` must be an inline arrow function containing a literal
   * `new Worker(new URL('...', import.meta.url), opts)` expression at the
   * call site — Vite only recognizes and bundles a worker entry point when
   * it can statically see that exact pattern. Routing the resolved URL
   * through a string (as this class used to do, taking a `workerUrl:
   * string` constructor param) defeats that analysis: the worker chunk
   * ships as raw, untranspiled `.ts` source and fails at runtime in a
   * production build (caught via a real `pnpm build` + `dist/` inspection,
   * not just `pnpm dev`, which transpiles on the fly regardless).
   */
  constructor(sessionKey: string, createWorker: () => Worker) {
    this.workerSession = acquireWorkerSession({
      key: sessionKey,
      idleTimeoutMs: 60_000,
      createWorker,
    });

    this.attachWorkerListeners(this.workerSession.worker);
  }

  private handleWorkerMessage = (e: MessageEvent): void => {
    const { id, result, error } = e.data as {
      id: number;
      result?: unknown;
      error?: string;
    };

    const pending = this.pendingQueries.get(id);
    if (!pending || pending.settled) {
      return;
    }

    pending.settled = true;
    clearTimeout(pending.timeout);
    this.pendingQueries.delete(id);
    this.workerSession.endRequest();

    if (error) {
      pending.reject(new Error(error));
      return;
    }

    pending.resolve(result);
  };

  private handleWorkerError = (e: ErrorEvent): void => {
    this.rejectAllPending(`Query worker error: ${e.message ?? 'unknown'}`);
    this.workerSession.terminateNow();
    this.attachedWorker = undefined;
  };

  private handleWorkerMessageError = (): void => {
    this.rejectAllPending('Query worker message deserialization error');
    this.workerSession.terminateNow();
    this.attachedWorker = undefined;
  };

  private attachWorkerListeners(worker: Worker): void {
    if (this.attachedWorker === worker) {
      return;
    }

    if (this.attachedWorker) {
      this.attachedWorker.removeEventListener('message', this.handleWorkerMessage);
      this.attachedWorker.removeEventListener('error', this.handleWorkerError);
      this.attachedWorker.removeEventListener('messageerror', this.handleWorkerMessageError);
    }

    this.attachedWorker = worker;
    worker.addEventListener('message', this.handleWorkerMessage);
    worker.addEventListener('error', this.handleWorkerError);
    worker.addEventListener('messageerror', this.handleWorkerMessageError);
  }

  private rejectAllPending(reason: string): void {
    const error = new Error(reason);
    for (const pending of this.pendingQueries.values()) {
      if (pending.settled) continue;
      pending.settled = true;
      clearTimeout(pending.timeout);
      this.workerSession.endRequest();
      pending.reject(error);
    }
    this.pendingQueries.clear();
  }

  private async postQuery<T>(type: string, parameters: object): Promise<T> {
    const worker = this.workerSession.worker;
    this.attachWorkerListeners(worker);
    const id = ++this.messageId;
    this.workerSession.beginRequest();

    return new Promise((resolve, reject) => {
      const pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: setTimeout(() => {
          if (pending.settled) return;

          pending.settled = true;
          this.pendingQueries.delete(id);
          this.workerSession.endRequest();
          reject(new Error('Query timeout'));
        }, WORKER_QUERY_TIMEOUT_MS),
        settled: false,
      };

      this.pendingQueries.set(id, pending);

      try {
        worker.postMessage({ id, type, params: parameters });
      } catch (error_) {
        if (!pending.settled) {
          pending.settled = true;
          clearTimeout(pending.timeout);
          this.pendingQueries.delete(id);
          this.workerSession.endRequest();
          reject(error_ instanceof Error ? error_ : new Error(String(error_)));
        }
      }
    });
  }

  async executeQuery(parameters: MessageQueryParameters): Promise<PaginatedResult<ChatMessage>> {
    return this.postQuery('query', parameters);
  }

  async executeCount(parameters: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number> {
    return this.postQuery('count', parameters);
  }

  async buildPageSeedMap(
    parameters: Omit<MessageQueryParameters, 'offset' | 'limit' | 'pageKeys'>,
    pageSize: number,
  ): Promise<number[]> {
    return this.postQuery<number[]>('seedmap', { ...parameters, _pageSize: pageSize });
  }

  canHandle(_parameters: MessageQueryParameters): boolean {
    return true;
  }

  destroy(): void {
    this.rejectAllPending('Query strategy destroyed');

    if (this.attachedWorker) {
      this.attachedWorker.removeEventListener('message', this.handleWorkerMessage);
      this.attachedWorker.removeEventListener('error', this.handleWorkerError);
      this.attachedWorker.removeEventListener('messageerror', this.handleWorkerMessageError);
      this.attachedWorker = undefined;
    }

    this.workerSession.terminateNow();
    this.workerSession.release();
  }
}

export class HybridQueryStrategy implements LegacyQueryStrategy {
  constructor(
    private readonly indexedDBStrategy: IndexedDBQueryStrategy,
    private readonly workerStrategy: WorkerQueryStrategy,
  ) { }

  private isComplexQuery(parameters: MessageQueryParameters): boolean {
    if (parameters.searchText) return true;
    if (!parameters.limit) return true;
    if (parameters.limit > WORKER_QUERY_ROW_THRESHOLD) return true;
    if (parameters.sortBy && parameters.sortBy.length > 1) return true;

    return false;
  }

  async executeQuery(parameters: MessageQueryParameters): Promise<PaginatedResult<ChatMessage>> {
    const strategy = this.isComplexQuery(parameters)
      ? this.workerStrategy
      : this.indexedDBStrategy;

    return strategy.executeQuery(parameters);
  }

  async executeCount(parameters: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number> {
    return this.indexedDBStrategy.executeCount(parameters);
  }

  async buildPageSeedMap(
    parameters: Omit<MessageQueryParameters, 'offset' | 'limit' | 'pageKeys'>,
    pageSize: number,
  ): Promise<number[]> {
    const sortField = (parameters.sortBy?.[0]?.field ?? 'timestamp') as string;
    if (parameters.searchText || sortField !== 'timestamp') {
      return this.workerStrategy.buildPageSeedMap(parameters, pageSize);
    }
    return this.indexedDBStrategy.buildPageSeedMap(parameters, pageSize);
  }

  canHandle(_parameters: MessageQueryParameters): boolean {
    return true;
  }

  destroy(): void {
    this.workerStrategy.destroy();
  }
}

/** SqlColumn-equivalent for the legacy adapter — mirrors infrastructure/sqlite/queryBuilder.ts's SqlColumn without importing it (application layer stays infrastructure-agnostic). */
type LegacySortColumn = 'timestamp' | 'from' | 'length' | 'id' | 'type';

const LEGACY_SORTABLE_FIELDS: readonly SortField[] = ['id', 'from', 'length', 'type'];

function resolveLegacySortColumn(sortBy: MessageQueryParameters['sortBy']): { field: SortField; column: LegacySortColumn; desc: boolean } {
  const primary = sortBy?.[0];
  const field = (primary?.field ?? 'timestamp') as SortField;
  const desc = (primary?.direction ?? 'desc') === 'desc';
  const isSortable = (LEGACY_SORTABLE_FIELDS as readonly string[]).includes(field);
  if (isSortable) return { field, column: field as LegacySortColumn, desc };
  return { field: 'timestamp', column: 'timestamp', desc };
}

function extractSortValue(message: ChatMessage, column: LegacySortColumn): number | string {
  if (column === 'timestamp') return message.timestamp.getTime();
  if (column === 'from') return message.from;
  if (column === 'length') return message.text?.length ?? 0;
  if (column === 'type') return message.type;
  return message.id;
}

/**
 * Adapts the old seed-map-based IndexedDB machinery to the new cursor-based
 * QueryStrategy interface so VirtualTableDataProxy can stay storage-agnostic.
 * No change to the underlying IndexedDB query logic — this only relocates
 * the "materialize a seed map per filter change, cache it, slice pages out
 * of it" bookkeeping that used to live directly in VirtualTableDataProxy.
 *
 * This is the fallback path only (see chatStorageBootstrap.ts): it inherits
 * the pre-migration 200,000-row verified scope, not the SQLite path's 1M.
 */
export class LegacyIndexedDbQueryStrategy implements QueryStrategy {
  private seedMap: number[] | undefined;
  private seedMapKey: string | undefined;
  private seedMapPromise: Promise<number[]> | undefined;

  constructor(private readonly inner: LegacyQueryStrategy) { }

  private keyFor(filter: Omit<MessageQueryParameters, 'offset' | 'limit'>): string {
    return JSON.stringify(filter);
  }

  private async ensureSeedMap(filter: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number[]> {
    const key = this.keyFor(filter);
    if (this.seedMapKey === key && this.seedMap) return this.seedMap;
    if (this.seedMapKey === key && this.seedMapPromise) return this.seedMapPromise;

    this.seedMapKey = key;
    const promise = this.inner.buildPageSeedMap(filter, 50);
    this.seedMapPromise = promise;
    const map = await promise;
    if (this.seedMapKey === key) {
      this.seedMap = map;
      this.seedMapPromise = undefined;
    }
    return map;
  }

  async fetchPage(params: FetchPageParams): Promise<FetchPageResult> {
    const { column } = resolveLegacySortColumn(params.filter.sortBy);
    const seedMap = await this.ensureSeedMap(params.filter);

    let startIndex = 0;
    if (params.cursor) {
      const index = seedMap.indexOf(params.cursor.id);
      startIndex = index === -1 ? seedMap.length : index + 1;
    }
    const pageKeys = seedMap.slice(startIndex, startIndex + params.limit);
    if (pageKeys.length === 0) return { items: [], nextCursor: undefined };

    const result = await this.inner.executeQuery({
      ...params.filter,
      pageKeys,
      knownTotal: seedMap.length,
    });

    const last = result.items.at(-1);
    const nextCursor: Cursor | undefined = last && pageKeys.length === params.limit
      ? { sortValue: extractSortValue(last, column), id: last.id }
      : undefined;
    return { items: result.items, nextCursor };
  }

  async count(filter: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number> {
    return this.inner.executeCount(filter);
  }

  async resolveRank(filter: Omit<MessageQueryParameters, 'offset' | 'limit'>, rank: number): Promise<ResolveRankResult> {
    const { column } = resolveLegacySortColumn(filter.sortBy);
    const seedMap = await this.ensureSeedMap(filter);
    const index = Math.min(Math.max(rank - 1, 0), seedMap.length - 1);
    if (index < 0 || seedMap.length === 0) return { cursorBefore: undefined, exact: true };

    const result = await this.inner.executeQuery({ ...filter, pageKeys: [seedMap[index]!], knownTotal: seedMap.length });
    const row = result.items[0];
    if (!row) return { cursorBefore: undefined, exact: true };
    return { cursorBefore: { sortValue: extractSortValue(row, column), id: row.id }, exact: true };
  }
}
