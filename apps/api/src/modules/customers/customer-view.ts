import type { CustomerView } from '@b2b/contracts';
import type { CustomerRow } from './customer.repository';

/**
 * Map an internal {@link CustomerRow} to the public {@link CustomerView}. Only
 * whitelisted fields cross the boundary: the sequential PK, `companyId` and
 * `deletedAt` are deliberately dropped (API_CONVENTIONS §7a). Public identity is
 * the UUID `publicId`.
 */
export function toCustomerView(row: CustomerRow): CustomerView {
  return {
    id: row.publicId,
    code: row.code,
    name: row.name,
    type: row.type,
    taxNumber: row.taxNumber,
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
