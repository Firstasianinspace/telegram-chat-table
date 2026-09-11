/**
 * Proxy Pattern (GoF) for Virtual Data Access.
 *
 * VirtualTableDataProxy presents an array-like interface to TanStack Table,
 * but fetches data on-demand with intelligent page caching (LRU).
 *
 * Storage-agnostic: this class knows nothing about IndexedDB or SQLite. It
 * only calls the injected QueryStrategy's cursor-based `fetchPage`/`count`/
 * `resolveRank` (see application/strategies/QueryStrategies.ts) — the
 * former seed-map machinery (a per-filter-change O(total table size) key
 * scan) has been removed entirely; the SQLite strategy answers "give me
 * rows 500,000-500,050 of this filtered/sorted set" directly via a keyset
 * query, and the legacy IndexedDB strategy still builds its own seed map
 * internally, just behind the same interface (see LegacyIndexedDbQueryStrategy).
 *
 * Cursor chaining: `pageCursors[i]` holds the cursor to fetch page i+1,
 * populated as pages are fetched in order. Sequential scroll (the common
 * case) never needs `resolveRank` — each next page reuses the previous
 * page's trailing cursor. A "cold jump" (e.g. dragging the scrollbar far
 * from the current position) has no cached cursor to chain from, so it
 * falls back to `resolveRank` once to seed that position, then chains
 * forward/backward from there like any other page.
 */

import type { ChatMessage } from '../domain/entities/types';
import type { MessageQueryParameters, Cursor } from '../domain/interfaces/IChatRepository';
import type { QueryStrategy } from '../application/strategies/QueryStrategies';

/**
 * LRU cache for pages.
 * Implements Least Recently Used eviction policy.
 */
class LRUPageCache<T> {
  private cache = new Map<number, T>();
  private accessOrder: number[] = [];

  constructor(private readonly maxPages: number = 20) { }

  get(pageIndex: number): T | undefined {
    const page = this.cache.get(pageIndex);
    if (page) {
      this.updateAccessOrder(pageIndex);
    }
    return page;
  }

  set(pageIndex: number, page: T): void {
    if (this.cache.size >= this.maxPages && !this.cache.has(pageIndex)) {
      const lruPage = this.accessOrder.shift();
      if (lruPage !== undefined) {
        this.cache.delete(lruPage);
      }
    }

    this.cache.set(pageIndex, page);
    this.updateAccessOrder(pageIndex);
  }

  private updateAccessOrder(pageIndex: number): void {
    const index = this.accessOrder.indexOf(pageIndex);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(pageIndex);
  }

  has(pageIndex: number): boolean {
    return this.cache.has(pageIndex);
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxPages,
    };
  }
}

interface PageMetadata {
  loading: boolean;
  loadPromise?: Promise<ChatMessage[]>;
  error?: Error;
}

/**
 * Virtual table data proxy.
 * Provides array-like access to paginated data with automatic loading and caching.
 *
 * Usage:
 * const proxy = new VirtualTableDataProxy(strategy, { pageSize: 50 })
 * proxy.updateFilters({ type: 'text' })
 * const row = await proxy.get(1500) // Automatically loads page 30
 */
export class VirtualTableDataProxy {
  private pageCache = new LRUPageCache<ChatMessage[]>();
  private pageMetadata = new Map<number, PageMetadata>();
  private totalCount = 0;
  private currentFilters: Omit<MessageQueryParameters, 'offset' | 'limit'> = {};

  /**
   * pageCursors[i] = the cursor to pass to fetchPage() to get page i+1 (i.e.
   * the last row of page i). Populated after every successful page fetch.
   * Cleared on every filter/sort change.
   */
  private pageCursors = new Map<number, Cursor>();

  /**
   * Bumped by clearCache() (i.e. on every filter/sort change). loadPage()
   * captures this value before starting a fetch and re-checks it after the
   * awaited load resolves — if it no longer matches, the fetch was started
   * under a superseded filter state and must NOT be written into pageCache.
   */
  private cacheGeneration = 0;

  /** Serializes updateFilters() calls so concurrent triggers can't race on currentFilters/totalCount. */
  private updateQueue: Promise<void> = Promise.resolve();

  /**
   * Set by clearCache() so the NEXT applyFilters() call always re-fetches
   * the count, even if the filter object itself is byte-identical to the
   * last one applied. Without this, calling reload() (used by callers that
   * know the underlying DATA changed — e.g. MessageTableLazy's `dataRevision`
   * watch, which fires after mock-data generation or a file import appends
   * new rows without touching any filter/sort state) would silently no-op:
   * applyFilters's unchanged-filter short-circuit would skip re-counting,
   * leaving totalCount stuck at its pre-generation value and get()/getRange()
   * returning nothing for every newly-generated row until the user touched
   * an actual filter or reloaded the page.
   */
  private forceNextApply = false;

  private stats = {
    cacheHits: 0,
    cacheMisses: 0,
    pagesLoaded: 0,
  };

  constructor(
    private readonly strategy: QueryStrategy,
    private readonly options: {
      pageSize: number;
      maxCachedPages?: number;
      prefetchPages?: number;
    },
  ) {
    this.pageCache = new LRUPageCache(options.maxCachedPages ?? 20);
  }

  getCount(): number {
    return this.totalCount;
  }

  /**
   * Update filters and refresh count. Serialized via updateQueue — see its
   * doc comment for why concurrent calls must not interleave.
   */
  async updateFilters(filters: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<void> {
    const run = this.updateQueue.then(() => this.applyFilters(filters));
    this.updateQueue = run.catch(() => { /* keep the queue alive; see doc comment above */ });
    return run;
  }

  private async applyFilters(filters: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<void> {
    const filtersChanged = JSON.stringify(filters) !== JSON.stringify(this.currentFilters);
    if (!filtersChanged && !this.forceNextApply) return;
    this.forceNextApply = false;

    this.currentFilters = filters;
    this.resetPageState();
    this.totalCount = await this.strategy.count(filters);
  }

  /**
   * Get an item at a specific index. Automatically loads the required page if not cached.
   */
  async get(index: number): Promise<ChatMessage | undefined> {
    if (index < 0 || index >= this.totalCount) {
      return undefined;
    }

    const pageIndex = Math.floor(index / this.options.pageSize);
    const indexInPage = index % this.options.pageSize;

    let page = this.pageCache.get(pageIndex);
    if (page) {
      this.stats.cacheHits++;
      return page[indexInPage];
    }

    this.stats.cacheMisses++;
    page = await this.loadPage(pageIndex);

    if (this.options.prefetchPages) {
      this.prefetchAdjacentPages(pageIndex);
    }

    return page[indexInPage];
  }

  /**
   * Get a range of items. Pages are loaded IN PARALLEL rather than one-by-one
   * so a visible window spanning multiple pages doesn't serialize N page-load
   * roundtrips.
   */
  async getRange(startIndex: number, endIndex: number): Promise<ChatMessage[]> {
    if (endIndex < startIndex || startIndex >= this.totalCount) return [];

    const clampedEnd = Math.min(endIndex, this.totalCount - 1);
    const startPage = Math.floor(startIndex / this.options.pageSize);
    const endPage = Math.floor(clampedEnd / this.options.pageSize);

    const pagesByIndex = new Map<number, ChatMessage[]>();
    const pagePromises: Promise<void>[] = [];
    for (let p = startPage; p <= endPage; p++) {
      const cachedPage = this.pageCache.get(p);
      if (cachedPage) {
        this.stats.cacheHits++;
        pagesByIndex.set(p, cachedPage);
        continue;
      }

      this.stats.cacheMisses++;
      pagePromises.push(this.loadPage(p).then((page) => {
        pagesByIndex.set(p, page);
      }));
    }
    await Promise.all(pagePromises);

    const items: ChatMessage[] = [];
    for (let index = startIndex; index <= clampedEnd; index++) {
      const pageIndex = Math.floor(index / this.options.pageSize);
      const indexInPage = index % this.options.pageSize;
      const page = pagesByIndex.get(pageIndex);
      if (page) {
        const item = page[indexInPage];
        if (item !== undefined) items.push(item);
      }
    }
    return items;
  }

  private async loadPage(pageIndex: number): Promise<ChatMessage[]> {
    const cached = this.pageCache.get(pageIndex);
    if (cached) {
      return cached;
    }

    const metadata = this.pageMetadata.get(pageIndex);
    if (metadata?.loading && metadata.loadPromise) {
      return metadata.loadPromise;
    }

    const requestGeneration = this.cacheGeneration;
    const loadPromise = this.executePageLoad(pageIndex);
    this.pageMetadata.set(pageIndex, { loading: true, loadPromise });

    try {
      const page = await loadPromise;

      if (requestGeneration !== this.cacheGeneration) {
        this.pageMetadata.delete(pageIndex);
        return page;
      }

      this.pageCache.set(pageIndex, page);
      this.pageMetadata.set(pageIndex, { loading: false });
      this.stats.pagesLoaded++;
      return page;
    } catch (error) {
      if (requestGeneration !== this.cacheGeneration) {
        this.pageMetadata.delete(pageIndex);
        throw error;
      }

      this.pageMetadata.set(pageIndex, {
        loading: false,
        error: error instanceof Error ? error : new Error('Failed to load page'),
      });
      throw error;
    }
  }

  /**
   * Resolve the cursor to fetch `pageIndex` — chaining from the previous
   * page's cursor when available (the common, cheap, sequential-scroll
   * case), or resolving it directly via the strategy's `resolveRank` when
   * there is no cached chain to build on (a cold jump).
   */
  private async resolveCursorForPage(pageIndex: number): Promise<Cursor | undefined> {
    if (pageIndex === 0) return undefined;

    const cached = this.pageCursors.get(pageIndex - 1);
    if (cached) return cached;

    const rank = pageIndex * this.options.pageSize;
    const { cursorBefore } = await this.strategy.resolveRank(this.currentFilters, rank);
    return cursorBefore;
  }

  private async executePageLoad(pageIndex: number): Promise<ChatMessage[]> {
    const cursor = await this.resolveCursorForPage(pageIndex);
    const { items, nextCursor } = await this.strategy.fetchPage({
      filter: this.currentFilters,
      cursor,
      limit: this.options.pageSize,
    });

    if (nextCursor) {
      this.pageCursors.set(pageIndex, nextCursor);
    }

    return items;
  }

  private prefetchAdjacentPages(pageIndex: number): void {
    const prefetchCount = this.options.prefetchPages ?? 0;
    const maxPageIndex = Math.ceil(this.totalCount / this.options.pageSize) - 1;

    for (let index = 1; index <= prefetchCount; index++) {
      const nextPageIndex = pageIndex + index;
      if (nextPageIndex <= maxPageIndex && !this.pageCache.has(nextPageIndex)) {
        this.loadPage(nextPageIndex).catch(() => { /* ignore prefetch errors */ });
      }

      const previousPageIndex = pageIndex - index;
      if (previousPageIndex >= 0 && !this.pageCache.has(previousPageIndex)) {
        this.loadPage(previousPageIndex).catch(() => { /* ignore prefetch errors */ });
      }
    }
  }

  private resetPageState(): void {
    this.pageCache.clear();
    this.pageMetadata.clear();
    this.pageCursors.clear();
    this.cacheGeneration++;
  }

  /**
   * Public entry point for "the underlying data or filter state may have
   * changed, please refresh" — also forces the next applyFilters() call to
   * re-fetch the count even if the filter object is unchanged (see
   * forceNextApply's doc comment).
   */
  clearCache(): void {
    this.resetPageState();
    this.forceNextApply = true;
  }

  getStats(): {
    cache: { size: number; maxSize: number };
    hits: number;
    misses: number;
    hitRate: number;
    pagesLoaded: number;
  } {
    const total = this.stats.cacheHits + this.stats.cacheMisses;
    return {
      cache: this.pageCache.getStats(),
      hits: this.stats.cacheHits,
      misses: this.stats.cacheMisses,
      hitRate: total > 0 ? this.stats.cacheHits / total : 0,
      pagesLoaded: this.stats.pagesLoaded,
    };
  }

  resetStats(): void {
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      pagesLoaded: 0,
    };
  }
}
