/**
 * Typed request/response protocol between the main thread and sqlite.worker.ts.
 *
 * The wire format is a generic `{ id, method, params }` envelope (see
 * sqliteWorkerClient.ts for why: ~20 distinct operations would otherwise need
 * a 20-branch discriminated union with no real safety benefit, since every
 * branch is dispatched the same way). Type safety instead lives at the
 * boundary: sqliteWorkerClient.ts exposes one strongly-typed method per
 * operation, and sqlite.worker.ts's handler table is keyed by the same
 * `SqliteMethod` union, so a typo in either place is a compile error.
 */

import type { ChatMessage, ChatParticipant } from '../../domain/entities/types';
import type { MessageQueryParameters, Cursor } from '../../domain/interfaces/IChatRepository';
import type { AnalyticsFilter, DateRange } from '../../application/queries/analyticsTypes';

export type SqliteMethod =
  | 'init'
  | 'migrateFromIndexedDb'
  | 'fetchPage'
  | 'count'
  | 'resolveRank'
  | 'saveMessages'
  | 'appendMessages'
  | 'removeLastMessages'
  | 'loadParticipants'
  | 'saveParticipants'
  | 'clear'
  | 'hasData'
  | 'beginBulkWrite'
  | 'endBulkWrite'
  | 'analyticsTopSenders'
  | 'analyticsDailyVolume'
  | 'analyticsHeatmap'
  | 'analyticsTimeOfDay'
  | 'loadCalls'
  | 'getCallCount';

export interface InitResult {
  crossOriginIsolated: boolean;
  locked: boolean;
  hasData: boolean;
}

export interface FetchPageParams {
  filter: Omit<MessageQueryParameters, 'offset' | 'limit'>;
  cursor: Cursor | undefined;
  limit: number;
}

export interface FetchPageResult {
  items: ChatMessage[];
  nextCursor: Cursor | undefined;
}

export interface ResolveRankParams {
  filter: Omit<MessageQueryParameters, 'offset' | 'limit'>;
  rank: number;
}

export interface ResolveRankResult {
  cursorBefore: Cursor | undefined;
  exact: boolean;
}

export interface SaveMessagesParams {
  messages: ChatMessage[];
  mode: 'replace' | 'append';
}

export interface MigrationProgress {
  phase: 'reading' | 'writing' | 'indexing' | 'done';
  processed: number;
  total: number;
}

/** Push-style messages the worker can send outside the request/response cycle. */
export interface WorkerPush {
  kind: 'push';
  event: 'migrationProgress';
  data: MigrationProgress;
}

export interface WorkerRequestEnvelope {
  kind: 'request';
  id: number;
  method: SqliteMethod;
  params: unknown;
}

export interface WorkerResponseEnvelope {
  kind: 'response';
  id: number;
  result?: unknown;
  error?: string;
}

export type WorkerOutboundMessage = WorkerResponseEnvelope | WorkerPush;

export interface AnalyticsTopSendersParams {
  filter?: AnalyticsFilter;
  limit?: number;
}

export interface AnalyticsDateRangeParams {
  dateRange?: DateRange;
}

export interface LoadCallsParams {
  dateRange?: { start: string; end: string };
}
