/**
 * Issue-invoice command DTO (Invoice/Billing Foundation).
 *
 * The invoice is built ENTIRELY from the SHIPPED order's server-priced snapshot —
 * the client supplies NO amounts, prices, totals or ids in the body. This DTO is
 * intentionally EMPTY so the strict validation pipe (`forbidNonWhitelisted`)
 * rejects ANY client-supplied field (e.g. `total`, `unitPrice`, `companyId`) with
 * a 400 (mass-assignment guard — API_CONVENTIONS §7).
 */
export class CreateInvoiceDto {}
