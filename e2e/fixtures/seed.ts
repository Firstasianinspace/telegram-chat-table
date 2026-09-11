import { test as base, type Page } from '@playwright/test';
import { MessageTablePage } from '../pages/MessageTablePage';

/**
 * Deterministic PRNG (same LCG as the app's `makePrng`).
 * Allows generating the exact same messages in Node and in browser.
 */
function makePrng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) & 0x7f_ff_ff_ff;
    return s / 0x7f_ff_ff_ff;
  };
}

export interface SeedMessage {
  id: number;
  type: string;
  timestamp: string; // ISO string — serialisable
  from: string;
  fromId: string;
  text?: string;
  file?: {
    name?: string;
    size?: number;
    mimeType?: string;
    duration?: number;
    width?: number;
    height?: number;
    stickerEmoji?: string;
  };
  serviceAction?: string;
  serviceActor?: string;
}

const TYPES = ['text', 'sticker', 'photo', 'video', 'audio', 'voice', 'animation', 'service'] as const;
const SENDERS = [
  { name: 'Alice', id: 'user_1' },
  { name: 'Bob', id: 'user_2' },
];

/**
 * Build an array of deterministic test messages in Node.js.
 *
 * Messages are spaced uniformly across `spanDays` *backwards* from `endDate`,
 * newest-first (id=0 is oldest, id=count-1 is newest).  This mirrors what
 * the app's mock-data generator produces.
 */
export function buildSeedMessages(options: {
  count: number;
  spanDays?: number;
  endDate?: Date;
  seed?: number;
  /** Restrict to specific types for deterministic assertions. */
  types?: typeof TYPES[number][];
}): SeedMessage[] {
  const {
    count,
    spanDays = 90,
    endDate = new Date('2026-03-01T12:00:00Z'),
    seed = 42,
    types = [...TYPES],
  } = options;

  const rand = makePrng(seed);
  const endMs = endDate.getTime();
  const spanMs = spanDays * 86_400_000;
  const startMs = endMs - spanMs;

  const messages: SeedMessage[] = [];

  for (let index = 0; index < count; index++) {
    // Distribute timestamps evenly across the span + tiny jitter.
    const fraction = count > 1 ? index / (count - 1) : 0;
    const jitter = (rand() - 0.5) * (spanMs / count);
    const ts = new Date(startMs + fraction * spanMs + jitter);

    const sender = SENDERS[Math.floor(rand() * SENDERS.length)]!;
    const type = types[Math.floor(rand() * types.length)]!;

    const message: SeedMessage = {
      id: index + 1,
      type,
      timestamp: ts.toISOString(),
      from: sender.name,
      fromId: sender.id,
    };

    switch (type) {
      case 'text': {
        message.text = `Message number ${index + 1} from ${sender.name}`;

        break;
      }
      case 'voice':
      case 'audio':
      case 'video': {
        message.file = {
          name: `file_${index + 1}.${type === 'voice' ? 'ogg' : type === 'audio' ? 'mp3' : 'mp4'}`,
          size: Math.floor(rand() * 10_000_000),
          mimeType: type === 'voice' ? 'audio/ogg' : type === 'audio' ? 'audio/mpeg' : 'video/mp4',
          duration: Math.floor(rand() * 600),
          width: type === 'video' ? 1920 : undefined,
          height: type === 'video' ? 1080 : undefined,
        };

        break;
      }
      case 'photo':
      case 'animation': {
        message.file = {
          name: `img_${index + 1}.${type === 'photo' ? 'jpg' : 'gif'}`,
          size: Math.floor(rand() * 5_000_000),
          mimeType: type === 'photo' ? 'image/jpeg' : 'image/gif',
          width: Math.floor(rand() * 3000) + 100,
          height: Math.floor(rand() * 3000) + 100,
        };

        break;
      }
      case 'sticker': {
        message.file = { stickerEmoji: '😀' };
        message.text = 'sticker caption';

        break;
      }
      case 'service': {
        message.serviceAction = 'phone_call';
        message.serviceActor = sender.name;

        break;
      }
      // No default
    }

    messages.push(message);
  }

  return messages;
}

/**
 * Seed chat data inside the browser with pre-generated messages, through
 * whichever storage backend chatStorageBootstrap.ts actually picked for
 * this page load (SQLite or the legacy IndexedDB fallback) — see
 * `src/app/e2eTestHooks.ts` for why writing to IndexedDB directly is not
 * safe to assume here.
 *
 * For this to work the page must have already been navigated to the app
 * origin (so main.ts's bootstrap has installed `window.__chatE2E`).
 */
interface ChatE2EWindow {
  __chatE2E?: {
    saveMessages(messages: SeedMessage[]): Promise<void>;
    clear(): Promise<void>;
  };
}

export async function seedDatabase(page: Page, messages: SeedMessage[]) {
  await page.waitForFunction(() => (window as unknown as ChatE2EWindow).__chatE2E !== undefined);
  await page.evaluate(async (msgs) => {
    await (window as unknown as ChatE2EWindow).__chatE2E!.saveMessages(msgs);
  }, messages);
}

/** Delete the ChatDatabase so tests start from a clean slate. */
export async function clearDatabase(page: Page) {
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const database of dbs) {
      if (database.name === 'ChatDatabase') {
        indexedDB.deleteDatabase(database.name);
      }
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Playwright test fixture — extends `test` with `messagePage` and
 * `seedMessages` helpers.
 * ──────────────────────────────────────────────────────────────────────── */

type Fixtures = {
  messagePage: MessageTablePage;
  seedMessages: (msgs: SeedMessage[]) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  messagePage: async ({ page }, use) => {
    await use(new MessageTablePage(page));
  },
  seedMessages: async ({ page }, use) => {
    await use(async (msgs: SeedMessage[]) => {
      // Navigate to the app first so Dexie creates / opens the DB with
      // the correct schema version.  Wait until the page is idle.
      await page.goto('/', { waitUntil: 'networkidle' });
      // Small delay to let Dexie's async open() complete.
      await page.waitForTimeout(500);
      await seedDatabase(page, msgs);
      // Reload so the Pinia store picks up the seeded data.
      await page.reload({ waitUntil: 'networkidle' });
    });
  },
});

export { expect } from '@playwright/test';
