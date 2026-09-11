/**
 * DEV-only bridge letting Playwright specs seed/clear chat data through
 * whichever storage backend chatStorageBootstrap.ts actually picked
 * (SQLite or the legacy IndexedDB fallback), instead of writing to
 * IndexedDB directly. Direct IndexedDB writes only reach the app when the
 * legacy fallback is active — the SQLite path never re-checks IndexedDB
 * once chatStorageBootstrap's one-time migration has already run (even a
 * no-op run against an empty database marks itself done), so a test that
 * seeded IndexedDB after that point would seed data the app never reads.
 *
 * Gated by import.meta.env.DEV, which is true for `pnpm dev` (what
 * playwright.config.ts's webServer runs) and false in production builds —
 * this never ships.
 */
import type { ChatRepository } from '@/modules/chat/domain/interfaces/IChatRepository';
import type { ChatMessage } from '@/modules/chat/domain/entities/types';

/**
 * Loosely typed on purpose: this is the wire format e2e specs serialize
 * through `page.evaluate`, built from their own `SeedMessage` shape
 * (e2e/fixtures/seed.ts), which doesn't import domain types. Cast to
 * ChatMessage once, here, at the trust boundary.
 */
export interface E2ESeedMessage {
  id: number;
  type: string;
  timestamp: string;
  from: string;
  fromId: string;
  text?: string;
  file?: ChatMessage['file'];
  serviceAction?: string;
  serviceActor?: string;
}

declare global {
  interface Window {
    __chatE2E?: {
      saveMessages(messages: E2ESeedMessage[]): Promise<void>;
      clear(): Promise<void>;
    };
  }
}

export function installE2ETestHooks(chatRepository: ChatRepository): void {
  if (!import.meta.env.DEV) return;

  globalThis.window.__chatE2E = {
    async saveMessages(messages: E2ESeedMessage[]): Promise<void> {
      const domainMessages: ChatMessage[] = messages.map((message) => ({
        ...message,
        type: message.type as ChatMessage['type'],
        timestamp: new Date(message.timestamp),
      }));
      await chatRepository.saveMessagesBatched(domainMessages);

      const participantsById = new Map<string, { id: string; name: string; isMe: boolean }>();
      for (const message of domainMessages) {
        if (!participantsById.has(message.fromId)) {
          participantsById.set(message.fromId, { id: message.fromId, name: message.from, isMe: false });
        }
      }
      await chatRepository.saveParticipants([...participantsById.values()]);
    },
    async clear(): Promise<void> {
      await chatRepository.clear();
    },
  };
}
