import type { ChatMessage, ChatParticipant, MessageType } from '../entities/types';

export type SortDirection = 'asc' | 'desc';

export type ChatNestedSortField =
  | 'file.name'
  | 'file.size'
  | 'file.mimeType'
  | 'file.duration'
  | 'file.width'
  | 'file.height'
  | 'file.stickerEmoji';

/**
 * 'length' is not a real ChatMessage key — it's the computed text-length
 * column defined in tableColumns.ts (`accessorFn: row => row.text?.length`).
 * It must be listed here so it round-trips correctly through sort state
 * instead of silently matching nothing (see SqliteChatRepository / the
 * "Length column" note in ENTERPRISE_TABLE_ARCHITECTURE.md).
 */
export type SortField = keyof ChatMessage | ChatNestedSortField | 'length';

export interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

export interface MessageQueryParameters {
  offset?: number;
  limit?: number;
  type?: MessageType | MessageType[];
  fromId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  searchText?: string;
  sortBy?: SortConfig[];
  /**
   * Pre-computed total count supplied by the caller (e.g. VirtualTableDataProxy).
   * When provided, paginateCollection skips its own count() roundtrip, saving one
   * O(n) IndexedDB call per page fetch.
   */
  knownTotal?: number;
  /**
   * Keyset pagination: when provided, the repository fetches exactly these
   * primary keys via `where('id').anyOf(pageKeys)` instead of using
   * `offset(n).limit(m)`.  This makes every page fetch O(pageSize × log n)
   * regardless of page depth, eliminating the O(total) offset scan.
   *
   * Populated by VirtualTableDataProxy after it builds the seed map.
   */
  pageKeys?: number[];
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/**
 * A resume point in a filtered+sorted result set: the primary sort column's
 * value and the tie-breaking `id` of the last row seen. Used by QueryStrategy
 * (see application/strategies/QueryStrategies.ts) for keyset pagination —
 * "give me the next `limit` rows after this one" — instead of OFFSET, which
 * is only cheap for a single ordered index scan (see queryBuilder.ts).
 */
export interface Cursor {
  sortValue: number | string;
  id: number;
}

export interface ChatRepository {
  loadMessagesPaginated(parameters: MessageQueryParameters): Promise<PaginatedResult<ChatMessage>>;
  getMessageCount(parameters?: Omit<MessageQueryParameters, 'offset' | 'limit'>): Promise<number>;
  saveMessages(messages: ChatMessage[]): Promise<void>;
  saveMessagesBatched(messages: ChatMessage[], batchSize?: number, onProgress?: (progress: number) => void): Promise<void>;
  appendMessagesBatched(messages: ChatMessage[], batchSize?: number): Promise<void>;
  removeLastMessages(count: number): Promise<number>;
  loadParticipants(): Promise<ChatParticipant[]>;
  saveParticipants(participants: ChatParticipant[]): Promise<void>;
  clear(): Promise<void>;
  hasData(): Promise<boolean>;
  /**
   * Optional bulk-write bracket around a sequence of many appendMessagesBatched
   * calls (a fresh file import or mock-data generation run). SqliteChatRepository
   * uses this to drop its secondary indexes before the run and rebuild them
   * once at the end — maintaining 10 B-tree indexes per row while
   * incrementally inserting hundreds of thousands of rows measured as an
   * increasingly severe slowdown (33ms -> 450ms per 1000-row batch between
   * 1,000 and 60,000 rows); rebuilding indexes once at the end costs a few
   * seconds regardless of table size (see ENTERPRISE_TABLE_ARCHITECTURE.md).
   * IndexedDBChatRepository has no equivalent concept and leaves these unset.
   */
  beginBulkWrite?(): Promise<void>;
  endBulkWrite?(): Promise<void>;
}
