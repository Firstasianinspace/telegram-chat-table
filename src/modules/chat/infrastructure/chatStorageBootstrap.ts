/**
 * Chooses the storage backend for the whole app at startup and performs the
 * one-time IndexedDB -> SQLite migration when applicable.
 *
 * SQLite + OPFS (the primary path, see docs/architecture/ENTERPRISE_TABLE_ARCHITECTURE.md)
 * requires cross-origin isolation:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 * (see vite.config.ts's dev-server headers and vercel.json's production headers).
 *
 * Fallback path: when those headers aren't present (crossOriginIsolated is
 * false), or another tab already holds the SQLite writer lock, this module
 * falls back to the pre-migration IndexedDB repositories untouched — same
 * 200,000-row verified scope as before, not the new 1,000,000. This is a
 * deliberate, documented degradation, not a bug: see "Known limitations" in
 * ENTERPRISE_TABLE_ARCHITECTURE.md.
 */

import type { ChatRepository } from '@/modules/chat/domain/interfaces/IChatRepository';
import type { ChatAnalyticsRepository } from './repositories/AnalyticsRepository';
import type { ICallRepository } from '@/modules/phone-call/application/callRepository';
import type { MigrationProgress } from './sqlite/sqliteProtocol';
import type { QueryStrategy } from '@/modules/chat/application/strategies/QueryStrategies';

export interface ChatStorageBundle {
  backend: 'sqlite' | 'indexeddb';
  chatRepository: ChatRepository;
  analyticsRepository: ChatAnalyticsRepository;
  callRepository: ICallRepository;
  /**
   * The QueryStrategy consumers inject via CHAT_QUERY_STRATEGY_KEY. Kept as
   * a sibling field rather than a method on ChatRepository so the domain
   * interface never has to import an application-layer type.
   */
  queryStrategy: QueryStrategy;
}

async function buildIndexedDbBundle(): Promise<ChatStorageBundle> {
  const { indexedDBChatRepository } = await import('./repositories/IndexedDBChatRepository');
  const { indexedDBChatAnalyticsRepository } = await import('./repositories/AnalyticsRepository');
  const { indexedDBCallRepository } = await import('@/modules/phone-call/infrastructure/repositories/IndexedDBCallRepository');
  return {
    backend: 'indexeddb',
    chatRepository: indexedDBChatRepository,
    analyticsRepository: indexedDBChatAnalyticsRepository,
    callRepository: indexedDBCallRepository,
    queryStrategy: indexedDBChatRepository.getQueryStrategy(),
  };
}

let resolvedBundle: ChatStorageBundle | undefined;

/**
 * The bundle resolved by the most recent initializeChatStorage() call, if
 * any — lets late consumers (e.g. useCallStats.ts, which resolves its
 * repository lazily on first query rather than at app boot) reuse the
 * already-decided backend instead of re-running feature detection.
 */
export function getResolvedChatStorageBundle(): ChatStorageBundle | undefined {
  return resolvedBundle;
}

export async function initializeChatStorage(
  onMigrationProgress?: (progress: MigrationProgress) => void,
): Promise<ChatStorageBundle> {
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  if (!crossOriginIsolated) {
    resolvedBundle = await buildIndexedDbBundle();
    return resolvedBundle;
  }

  try {
    const { getSqliteWorkerClient } = await import('./sqlite/sqliteWorkerClient');
    const client = getSqliteWorkerClient();
    const initResult = await client.init();

    if (initResult.locked || !initResult.crossOriginIsolated) {
      resolvedBundle = await buildIndexedDbBundle();
      return resolvedBundle;
    }

    if (onMigrationProgress) {
      client.onMigrationProgress(onMigrationProgress);
    }
    await client.migrateFromIndexedDb();

    const { SqliteChatRepository } = await import('./repositories/SqliteChatRepository');
    const { SqliteChatAnalyticsRepository } = await import('./repositories/SqliteAnalyticsRepository');
    const { SqliteCallRepository } = await import('@/modules/phone-call/infrastructure/repositories/SqliteCallRepository');

    const chatRepository = new SqliteChatRepository(client);
    resolvedBundle = {
      backend: 'sqlite',
      chatRepository,
      analyticsRepository: new SqliteChatAnalyticsRepository(client),
      callRepository: new SqliteCallRepository(client),
      queryStrategy: chatRepository.getQueryStrategy(),
    };
    return resolvedBundle;
  } catch (error) {
    console.error('[chatStorageBootstrap] SQLite init failed, falling back to IndexedDB:', error);
    resolvedBundle = await buildIndexedDbBundle();
    return resolvedBundle;
  }
}
