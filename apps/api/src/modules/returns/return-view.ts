import type { ReturnItemView, ReturnView } from '@b2b/contracts';
import type { ReturnItemRow, ReturnRow } from './return.repository';

/**
 * Map an internal {@link ReturnRow} to the public {@link ReturnView}. Only
 * whitelisted fields cross the boundary (API_CONVENTIONS §7a/§7b): the sequential
 * PK, `companyId`, `createdById`/`approvedById`, the internal `warehouseId`/
 * `orderItemId` and — above all — the raw `idempotencyKey`/`approveIdempotencyKey`
 * are dropped. Identity is the UUID `publicId`s; quantity is a BIGINT string.
 */
export function toReturnView(row: ReturnRow): ReturnView {
  return {
    id: row.publicId,
    returnNo: row.returnNo,
    status: row.status,
    orderId: row.order.publicId,
    customerId: row.customer.publicId,
    warehouseId: row.warehouse.publicId,
    invoiceId: row.invoice?.publicId ?? null,
    reason: row.reason,
    items: row.items.map(toReturnItemView),
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
  };
}

function toReturnItemView(row: ReturnItemRow): ReturnItemView {
  return {
    productId: row.product.publicId,
    quantity: row.quantity.toString(),
    reason: row.reason,
  };
}
