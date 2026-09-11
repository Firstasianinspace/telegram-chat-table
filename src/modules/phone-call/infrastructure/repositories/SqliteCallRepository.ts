import type { ICallRepository } from '../../application/callRepository';
import type { PhoneCall } from '../../domain/types';
import type { SqliteWorkerClient } from '@/modules/chat/infrastructure/sqlite/sqliteWorkerClient';

/**
 * SQLite-backed implementation of ICallRepository — queries the same
 * `messages` table SqliteChatRepository writes to, filtered to
 * `type='service' AND service_action='phone_call'` (see sqlite.worker.ts's
 * loadCalls/getCallCount handlers).
 */
export class SqliteCallRepository implements ICallRepository {
  constructor(private readonly client: SqliteWorkerClient) { }

  async loadCalls(dateRange?: { start: string; end: string }): Promise<PhoneCall[]> {
    return this.client.loadCalls({ dateRange });
  }

  async getCallCount(): Promise<number> {
    return this.client.getCallCount();
  }
}
