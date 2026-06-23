/**
 * Small shared helpers for the report tabs.
 *
 * Report date filters are UTC day-granular (the backend treats `dateFrom`/`dateTo`
 * as inclusive UTC days), so the default range is derived from the UTC clock to
 * avoid an off-by-one near midnight in non-UTC locales.
 */

/** A warehouse choice for the optional warehouse filter (public id + label). */
export interface WarehouseOption {
  id: string;
  label: string;
}

/** Today as an ISO `YYYY-MM-DD` string (UTC). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** First day of the current month as an ISO `YYYY-MM-DD` string (UTC). */
export function monthStartIso(): string {
  return `${todayIso().slice(0, 7)}-01`;
}
