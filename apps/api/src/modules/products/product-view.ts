import type { ProductView } from '@b2b/contracts';
import type { ProductRow } from './product.repository';

/**
 * Map an internal {@link ProductRow} to the public {@link ProductView}. Only
 * whitelisted fields cross the boundary: the sequential PK, `companyId` and
 * `deletedAt` are deliberately dropped (API_CONVENTIONS §7a). Big integers are
 * serialised as strings to avoid JSON precision loss.
 */
export function toProductView(row: ProductRow): ProductView {
  return {
    id: row.publicId,
    sku: row.sku,
    name: row.name,
    description: row.description,
    barcode: row.barcode,
    unit: row.unit,
    categoryId: row.categoryId === null ? null : row.categoryId.toString(),
    vatRate: row.taxRateBp,
    listPrice: { amount: row.listPriceAmount.toString(), currency: row.currency },
    isActive: row.isActive,
    criticalStockThreshold:
      row.criticalStockThreshold === null ? null : row.criticalStockThreshold.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
