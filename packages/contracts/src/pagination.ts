/**
 * Generic cursor-pagination envelope (API_CONVENTIONS §4).
 *
 * List endpoints return `{ data, pageInfo }`. The cursor is an OPAQUE token the
 * client echoes back verbatim via `?cursor=` — it encodes the last item's
 * position, never a raw sequential id, so the surface stays IDOR-safe (§7b).
 */
export interface PageInfo {
  /** Opaque cursor to pass as `?cursor=` for the next page, or null at the end. */
  nextCursor: string | null;
  /** Whether another page exists after this one. */
  hasNextPage: boolean;
}

/** A single page of `T` plus the cursor to fetch the next one. */
export interface Paginated<T> {
  data: T[];
  pageInfo: PageInfo;
}
