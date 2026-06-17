import type { OrderItemView, OrderView } from '@b2b/contracts';
import type { OrderItemRow, OrderRow } from './order.repository';

/**
 * Map an internal {@link OrderRow} to the public {@link OrderView}. Only
 * whitelisted fields cross the boundary (API_CONVENTIONS §7a/§7b): the sequential
 * PK, `companyId`, `createdById`, the internal `warehouseId` and the raw line ids
 * are dropped. Identity is the UUID `publicId`s; money is `{ amount, currency }`
 * with `amount` a BIGINT string; quantity is a BIGINT string.
 */
export function toOrderView(row: OrderRow): OrderView {
  return {
    id: row.publicId,
    orderNo: row.orderNo,
    customerId: row.customer.publicId,
    warehouseId: row.warehouse.publicId,
    status: row.status,
    currency: row.currency,
    subtotal: { amount: row.subtotalAmount.toString(), currency: row.currency },
    vat: { amount: row.taxAmount.toString(), currency: row.currency },
    total: { amount: row.grandTotalAmount.toString(), currency: row.currency },
    note: row.notes,
    items: row.items.map((i) => toOrderItemView(i, row.currency)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
}

function toOrderItemView(row: OrderItemRow, currency: string): OrderItemView {
  return {
    productId: row.product.publicId,
    sku: row.productSku,
    name: row.productName,
    quantity: row.quantity.toString(),
    unitPrice: { amount: row.unitPriceAmount.toString(), currency },
    vatRate: row.taxRateBp,
    lineSubtotal: { amount: row.lineSubtotalAmount.toString(), currency },
    lineVat: { amount: row.lineTaxAmount.toString(), currency },
    lineTotal: { amount: row.lineTotalAmount.toString(), currency },
  };
}
