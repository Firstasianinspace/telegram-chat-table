/**
 * SQLite-backed implementation of ChatRepository, running against
 * sqlite.worker.ts via SqliteWorkerClient. Lives alongside
 * IndexedDBChatRepository behind the same domain interface — see
 * chatStorageBootstrap.ts for how the app picks one at startup.
 */

import type { ChatRepository, MessageQueryParameters, PaginatedResult } from '@/modules/chat/domain/interfaces/IChatRepository';
import type { ChatMessage, ChatParticipant } from '@/modules/chat/domain/entities/types';
import { SqliteQueryStrategy, type QueryStrategy } from '@/modules/chat/application/strategies/QueryStrategies';
import type { SqliteWorkerClient } from '../sqlite/sqliteWorkerClient';

export class SqliteChatRepository implements ChatRepository {
  private readonly queryStrategy: QueryStrategy;

  constructor(private readonly client: SqliteWorkerClient) {
    this.queryStrategy = new SqliteQueryStrategy(client);
  }

  getQueryStrategy(): QueryStrategy {
    return this.queryStrategy;
  }

  /**
   * Only used for a plain, non-virtualized load (nothing in the current UI
   * calls this with offset/limit unset at scale — the table always goes
   * through VirtualTableDataProxy / getQueryStrategy()). Kept for interface
   * completeness and small call sites like tests.
   */
  async loadMessagesPaginated(parameters: MessageQueryParameters): Promise<PaginatedResult<ChatMessage>> {
    const { offset = 0, limit, ...filter } = parameters;
    const total = await this.client.count(filter);
    if (limit === undefined) {
      const { items } = await this.client.fetchPage({ filter, cursor: undefined, limit: total || 1 });
      return { items, total, hasMore: false };
    }
    const { cursorBefore } = await this.client.resolveRank({ filter, rank: offset });
    const { items } = await this.client.fetchPage({ filter, cursor: cursorBefore, limit });
    return { items, total, hasMore: offset + items.length < total };
  }

  async getMessageCount(parameters: Omit<MessageQueryParameters, 'offset' | 'limit'> = {}): Promise<number> {
    return this.client.count(parameters);
  }

  async saveMessages(messages: ChatMessage[]): Promise<void> {
    await this.client.beginBulkWrite();
    try {
      await this.client.saveMessages(messages, 'replace');
    } finally {
      await this.client.endBulkWrite();
    }
  }

  /**
   * One-shot bulk replace: self-brackets with beginBulkWrite/endBulkWrite
   * since it's inherently a bulk operation regardless of caller discipline.
   * Contrast with appendMessagesBatched below, which is called many times
   * per import session and must NOT self-bracket — see its doc comment.
   */
  async saveMessagesBatched(
    messages: ChatMessage[],
    batchSize = 1000,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    await this.client.clear();
    await this.client.beginBulkWrite();
    try {
      const total = messages.length;
      for (let index = 0; index < total; index += batchSize) {
        const batch = messages.slice(index, index + batchSize);
        await this.client.appendMessages(batch);
        onProgress?.(Math.round(Math.min(index + batch.length, total) / total * 100));
        if (index + batchSize < total) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } finally {
      await this.client.endBulkWrite();
    }
  }

  /**
   * Called many times per import/generation session (once per parsed or
   * generated chunk) — does NOT self-bracket with beginBulkWrite/endBulkWrite,
   * since dropping and rebuilding all 10 indexes on every chunk would be far
   * worse than doing nothing. The caller (store.ts's clearData/finalize hooks)
   * brackets the whole multi-chunk session instead.
   */
  async appendMessagesBatched(messages: ChatMessage[], batchSize = 1000): Promise<void> {
    const total = messages.length;
    for (let index = 0; index < total; index += batchSize) {
      const batch = messages.slice(index, index + batchSize);
      await this.client.appendMessages(batch);
      if (index + batchSize < total) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  async removeLastMessages(count: number): Promise<number> {
    return this.client.removeLastMessages(count);
  }

  async loadParticipants(): Promise<ChatParticipant[]> {
    return this.client.loadParticipants();
  }

  async saveParticipants(participants: ChatParticipant[]): Promise<void> {
    await this.client.saveParticipants(participants);
  }

  async clear(): Promise<void> {
    await this.client.clear();
  }

  async hasData(): Promise<boolean> {
    return this.client.hasData();
  }

  async beginBulkWrite(): Promise<void> {
    await this.client.beginBulkWrite();
  }

  async endBulkWrite(): Promise<void> {
    await this.client.endBulkWrite();
  }
}
