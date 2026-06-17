/**
 * Public customer view-models (read DTOs) — Customer Management Foundation.
 *
 * These are the ONLY shapes the API returns for customer resources. They are
 * hand-written contracts, never derived from Prisma models, so internal fields
 * (sequential PK, `companyId`, `deletedAt`) never leak (API_CONVENTIONS §7a/§7b).
 * Public identity is the UUID `publicId`; the sequential PK is never exposed.
 */

import type { Paginated } from './pagination';

/** Safe, whitelisted projection of a customer card. */
export interface CustomerView {
  /** Public UUID identity (never the sequential PK). */
  id: string;
  /** Company-unique customer code/number (among the company's active customers). */
  code: string;
  name: string;
  /** Customer kind: "COMPANY" or "INDIVIDUAL". */
  type: string;
  taxNumber: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A page of customers. */
export type CustomerListView = Paginated<CustomerView>;
