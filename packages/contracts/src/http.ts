/**
 * Stable, machine-readable error codes (RFC 7807 `code`).
 * Clients branch on these; `title` is the human-readable companion.
 * Mirrors docs/ERROR_HANDLING.md §2.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_STATE',
  'CONFLICT',
  'IDEMPOTENCY_MISMATCH',
  'INSUFFICIENT_STOCK',
  'BUSINESS_RULE',
  'PRICE_OVERRIDE_FORBIDDEN',
  'GRANT_CEILING',
  'OVERPAYMENT',
  'DUPLICATE_IMPORT',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Per-field validation detail. */
export interface ProblemFieldError {
  field: string;
  message: string;
}

/**
 * RFC 7807 problem+json body. The single response shape for all API errors.
 * See docs/ERROR_HANDLING.md §1.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: ProblemFieldError[];
}
