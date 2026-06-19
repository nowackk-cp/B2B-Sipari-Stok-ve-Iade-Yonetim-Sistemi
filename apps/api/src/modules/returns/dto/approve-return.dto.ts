/**
 * Approve-return command DTO (Return/Refund Foundation).
 *
 * The approval takes NO client fields — it restocks the return's existing lines.
 * This DTO is intentionally EMPTY so the strict validation pipe
 * (`forbidNonWhitelisted`) rejects ANY client-supplied field (e.g. `quantity`,
 * `status`, `companyId`) with a 400 (mass-assignment guard — API_CONVENTIONS §7).
 */
export class ApproveReturnDto {}
