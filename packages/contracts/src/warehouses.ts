/**
 * Public warehouse view-models (read DTOs) — TASK-012.
 *
 * These are the ONLY shapes the API returns for warehouse resources. They are
 * hand-written contracts, never derived from Prisma models, so internal fields
 * (sequential PK, `companyId`, `deletedAt`) never leak (API_CONVENTIONS §7a/§7b).
 * Public identity is the UUID `publicId`; the sequential PK is never exposed.
 */

import type { Paginated } from './pagination';

/** Safe, whitelisted projection of a warehouse master-data record. */
export interface WarehouseView {
  /** Public UUID identity (never the sequential PK). */
  id: string;
  /** Warehouse code (unique among the company's active warehouses). */
  code: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2 country code, or null. */
  country: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A page of warehouses. */
export type WarehouseListView = Paginated<WarehouseView>;
