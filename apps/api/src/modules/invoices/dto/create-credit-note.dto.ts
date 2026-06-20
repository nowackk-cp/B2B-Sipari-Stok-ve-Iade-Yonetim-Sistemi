/**
 * Issue-credit-note command DTO (Return Invoice / Credit Note Foundation).
 *
 * The credit note is built ENTIRELY from the APPROVED return + the original
 * order/invoice server-priced snapshot — the client supplies NO amounts, prices,
 * totals or ids in the body. This DTO is intentionally EMPTY so the strict
 * validation pipe (`forbidNonWhitelisted`) rejects ANY client-supplied field (e.g.
 * `total`, `unitPrice`, `companyId`) with a 400 (mass-assignment guard —
 * API_CONVENTIONS §7).
 */
export class CreateCreditNoteDto {}
