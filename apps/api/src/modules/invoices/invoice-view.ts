import type { InvoiceItemView, InvoiceView } from '@b2b/contracts';
import type { InvoiceItemRow, InvoiceRow } from './invoice.repository';

/**
 * Map an internal {@link InvoiceRow} to the public {@link InvoiceView}. Only
 * whitelisted fields cross the boundary (API_CONVENTIONS §7a/§7b): the sequential
 * PK, `companyId`, `createdById`, the internal `warehouseId`/`orderId` and — above
 * all — the raw `idempotencyKey` are dropped. Identity is the UUID `publicId`s;
 * money is `{ amount, currency }` with `amount` a BIGINT string; quantity is a
 * BIGINT string.
 */
export function toInvoiceView(row: InvoiceRow): InvoiceView {
  return {
    id: row.publicId,
    invoiceNo: row.invoiceNo,
    invoiceNumber: row.invoiceNumber !== null ? row.invoiceNumber.toString() : null,
    seriesCode: row.series?.seriesCode ?? null,
    fiscalYear: row.fiscalYear,
    status: row.status,
    orderId: row.order?.publicId ?? null,
    customerId: row.customer.publicId,
    warehouseId: row.warehouse?.publicId ?? null,
    currency: row.currency,
    subtotal: { amount: row.subtotalAmount.toString(), currency: row.currency },
    vat: { amount: row.taxAmount.toString(), currency: row.currency },
    total: { amount: row.grandTotalAmount.toString(), currency: row.currency },
    items: row.items.map((i) => toInvoiceItemView(i, row.currency)),
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toInvoiceItemView(row: InvoiceItemRow, currency: string): InvoiceItemView {
  return {
    productId: row.product?.publicId ?? null,
    description: row.description,
    quantity: row.quantity.toString(),
    unitPrice: { amount: row.unitPriceAmount.toString(), currency },
    vatRate: row.taxRateBp,
    lineSubtotal: { amount: row.lineSubtotalAmount.toString(), currency },
    lineVat: { amount: row.lineTaxAmount.toString(), currency },
    lineTotal: { amount: row.lineTotalAmount.toString(), currency },
  };
}
