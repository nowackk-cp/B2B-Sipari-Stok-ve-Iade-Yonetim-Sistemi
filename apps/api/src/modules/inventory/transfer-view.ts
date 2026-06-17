import type { StockTransferView } from '@b2b/contracts';
import type { TransferRow } from './stock.repository';

/**
 * Map an internal {@link TransferRow} to the public {@link StockTransferView}.
 * Only whitelisted fields cross the boundary (API_CONVENTIONS §7a/§7b): the
 * sequential PK, the internal warehouse/product ids and the raw `idempotency_key`
 * are dropped; identity is the UUID `publicId`s, and `quantity` is the positive
 * BIGINT string.
 */
export function toTransferView(row: TransferRow): StockTransferView {
  return {
    id: row.publicId,
    fromWarehouseId: row.fromWarehouse.publicId,
    toWarehouseId: row.toWarehouse.publicId,
    productId: row.product.publicId,
    sku: row.product.sku,
    name: row.product.name,
    quantity: row.quantity.toString(),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}
