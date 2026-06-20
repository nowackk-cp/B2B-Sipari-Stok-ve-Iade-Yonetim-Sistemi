import type { CreditNoteItemView, CreditNoteView } from '@b2b/contracts';
import type { CreditNoteItemRow, CreditNoteRow } from './credit-note.repository';

/**
 * Map an internal {@link CreditNoteRow} to the public {@link CreditNoteView}. Only
 * whitelisted fields cross the boundary (API_CONVENTIONS §7a/§7b): the sequential
 * PK, `companyId`, `createdById`, the internal `warehouseId`/`returnId` and — above
 * all — the raw `idempotencyKey` are dropped. Identity is the UUID `publicId`s;
 * money is `{ amount, currency }` with `amount` a BIGINT string; quantity is a
 * BIGINT string.
 */
export function toCreditNoteView(row: CreditNoteRow): CreditNoteView {
  return {
    id: row.publicId,
    creditNoteNo: row.creditNoteNo,
    creditNoteNumber: row.creditNoteNumber.toString(),
    seriesCode: row.series.seriesCode,
    fiscalYear: row.fiscalYear,
    status: row.status,
    returnId: row.return.publicId,
    orderId: row.order.publicId,
    originalInvoiceId: row.originalInvoice.publicId,
    customerId: row.customer.publicId,
    warehouseId: row.warehouse.publicId,
    currency: row.currency,
    subtotal: { amount: row.subtotalAmount.toString(), currency: row.currency },
    vat: { amount: row.taxAmount.toString(), currency: row.currency },
    total: { amount: row.grandTotalAmount.toString(), currency: row.currency },
    items: row.items.map((i) => toCreditNoteItemView(i, row.currency)),
    issuedAt: row.issuedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toCreditNoteItemView(row: CreditNoteItemRow, currency: string): CreditNoteItemView {
  return {
    productId: row.product.publicId,
    description: row.description,
    quantity: row.quantity.toString(),
    unitPrice: { amount: row.unitPriceAmount.toString(), currency },
    vatRate: row.taxRateBp,
    lineSubtotal: { amount: row.lineSubtotalAmount.toString(), currency },
    lineVat: { amount: row.lineTaxAmount.toString(), currency },
    lineTotal: { amount: row.lineTotalAmount.toString(), currency },
  };
}
