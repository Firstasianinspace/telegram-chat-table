/**
 * Main-thread client for sqlite.worker.ts. This worker holds a single,
 * long-lived OPFS connection for the app's entire lifetime (unlike the old
 * query/sort workers, which were stateless and safe to recycle on idle) — so
 * it is a plain module-level singleton, not something acquired through
 * workerSessionManager's idle-timeout pool.
 */

import type {
  SqliteMethod,
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
import type { SenderCount, DailyVolumePoint, HeatmapPoint, TimeSlotCount } from '../../application/queries/analyticsTypes';
import type { PhoneCall } from '../../../phone-call/domain/types';

const REQUEST_TIMEOUT_MS = 30_000;

export class SqliteWorkerClient {
  private worker: Worker;
  private messageId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timeout: ReturnType<typeof setTimeout> }>();
  private migrationListeners = new Set<(progress: MigrationProgress) => void>();

  constructor() {
    // Vite only recognizes a worker entry point (and bundles/transpiles it,
    // rather than copying the raw .ts source as a static asset) when it can
    // statically see this exact `new Worker(new URL('...', import.meta.url))`
    // expression inline — routing the URL through a variable or a
    // constructor parameter defeats that analysis. See the ENTERPRISE_TABLE
    // ARCHITECTURE.md changelog: this shipped broken in a production build
    // (dist/assets/sqlite.worker-*.ts, raw untranspiled source) before this
    // was caught.
    this.worker = new Worker(new URL('sqlite.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerOutboundMessage>) => {
      const message = event.data;
      if (message.kind === 'push') {
        if (message.event === 'migrationProgress') {
          for (const listener of this.migrationListeners) listener(message.data);
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error));
        return;
      }
      pending.resolve(message.result);
    });
    this.worker.addEventListener('error', (event) => {
      this.rejectAll(new Error(`sqlite.worker error: ${event.message}`));
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private call<T>(method: SqliteMethod, params: unknown = {}): Promise<T> {
    const id = ++this.messageId;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sqlite.worker call "${method}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
      const envelope: WorkerRequestEnvelope = { kind: 'request', id, method, params };
      this.worker.postMessage(envelope);
    });
  }

  onMigrationProgress(listener: (progress: MigrationProgress) => void): () => void {
    this.migrationListeners.add(listener);
    return () => this.migrationListeners.delete(listener);
  }

  init(): Promise<InitResult> {
    return this.call('init');
  }

  migrateFromIndexedDb(): Promise<{ migrated: boolean; count: number }> {
    return this.call('migrateFromIndexedDb');
  }

  fetchPage(params: FetchPageParams): Promise<FetchPageResult> {
    return this.call('fetchPage', params);
  }

  count(filter: FetchPageParams['filter']): Promise<number> {
    return this.call('count', filter);
  }

  resolveRank(params: ResolveRankParams): Promise<ResolveRankResult> {
    return this.call('resolveRank', params);
  }

  saveMessages(messages: ChatMessage[], mode: SaveMessagesParams['mode']): Promise<void> {
    return this.call('saveMessages', { messages, mode });
  }

  appendMessages(messages: ChatMessage[]): Promise<void> {
    return this.call('appendMessages', { messages, mode: 'append' });
  }

  removeLastMessages(count: number): Promise<number> {
    return this.call('removeLastMessages', { count });
  }

  loadParticipants(): Promise<ChatParticipant[]> {
    return this.call('loadParticipants');
  }

  saveParticipants(participants: ChatParticipant[]): Promise<void> {
    return this.call('saveParticipants', { participants });
  }

  clear(): Promise<void> {
    return this.call('clear');
  }

  hasData(): Promise<boolean> {
    return this.call('hasData');
  }

  beginBulkWrite(): Promise<void> {
    return this.call('beginBulkWrite');
  }

  endBulkWrite(): Promise<void> {
    return this.call('endBulkWrite');
  }

  analyticsTopSenders(params: AnalyticsTopSendersParams): Promise<SenderCount[]> {
    return this.call('analyticsTopSenders', params);
  }

  analyticsDailyVolume(params: AnalyticsDateRangeParams): Promise<DailyVolumePoint[]> {
    return this.call('analyticsDailyVolume', params);
  }

  analyticsHeatmap(params: AnalyticsDateRangeParams): Promise<HeatmapPoint[]> {
    return this.call('analyticsHeatmap', params);
  }

  analyticsTimeOfDay(params: AnalyticsDateRangeParams): Promise<TimeSlotCount[]> {
    return this.call('analyticsTimeOfDay', params);
  }

  loadCalls(params: LoadCallsParams): Promise<PhoneCall[]> {
    return this.call('loadCalls', params);
  }

  getCallCount(): Promise<number> {
    return this.call('getCallCount');
  }

  destroy(): void {
    this.rejectAll(new Error('SqliteWorkerClient destroyed'));
    this.worker.terminate();
  }
}

let singleton: SqliteWorkerClient | undefined;

export function getSqliteWorkerClient(): SqliteWorkerClient {
  if (!singleton) {
    singleton = new SqliteWorkerClient();
  }
  return singleton;
}

/** Test-only: allows resetting the singleton between test cases. */
export function resetSqliteWorkerClientForTests(): void {
  singleton?.destroy();
  singleton = undefined;
}
