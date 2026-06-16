import type { StockBalanceView, StockMovementView } from '@b2b/contracts';
import type { BalanceRow, MovementRow } from './stock.repository';

/**
 * Map an internal {@link BalanceRow} to the public {@link StockBalanceView}. Only
 * whitelisted fields cross the boundary: the sequential balance PK and raw
 * counters' internal names are dropped; `quantity` is the on-hand and
 * `availableQuantity` is `on_hand − reserved`, both serialised as BIGINT strings
 * (API_CONVENTIONS §5/§7a). Warehouse/product identity is the UUID `publicId`.
 */
export function toBalanceView(row: BalanceRow): StockBalanceView {
  return {
    warehouseId: row.warehouse.publicId,
    productId: row.product.publicId,
    sku: row.product.sku,
    name: row.product.name,
    quantity: row.onHand.toString(),
    availableQuantity: (row.onHand - row.reserved).toString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Map an internal {@link MovementRow} to the public {@link StockMovementView}.
 * The ledger stores a SIGNED quantity; the view exposes a positive magnitude
 * plus an explicit `direction`, and derives `balanceBefore` from the immutable
 * `balanceAfter` (`before = after − signed`). The sequential ledger PK is never
 * exposed (API_CONVENTIONS §7b).
 */
export function toMovementView(row: MovementRow): StockMovementView {
  const signed = row.quantity;
  const magnitude = signed < 0n ? -signed : signed;
  return {
    warehouseId: row.warehouse.publicId,
    productId: row.product.publicId,
    sku: row.product.sku,
    name: row.product.name,
    type: row.changeType,
    direction: signed < 0n ? 'DECREASE' : 'INCREASE',
    quantity: magnitude.toString(),
    balanceBefore: (row.balanceAfter - signed).toString(),
    balanceAfter: row.balanceAfter.toString(),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}
