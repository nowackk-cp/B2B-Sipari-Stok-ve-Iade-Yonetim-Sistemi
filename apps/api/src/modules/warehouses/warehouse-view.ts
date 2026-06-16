import type { WarehouseView } from '@b2b/contracts';
import type { WarehouseRow } from './warehouse.repository';

/**
 * Map an internal {@link WarehouseRow} to the public {@link WarehouseView}. Only
 * whitelisted fields cross the boundary: the sequential PK, `companyId` and
 * `deletedAt` are deliberately dropped (API_CONVENTIONS §7a). The public id is
 * the UUID `publicId`.
 */
export function toWarehouseView(row: WarehouseRow): WarehouseView {
  return {
    id: row.publicId,
    code: row.code,
    name: row.name,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    postalCode: row.postalCode,
    country: row.country,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
