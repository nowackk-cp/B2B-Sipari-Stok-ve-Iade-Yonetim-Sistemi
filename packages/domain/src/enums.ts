/**
 * Domain status enumerations.
 *
 * These mirror the PostgreSQL native enums declared in the Prisma schema
 * (see docs/architecture/DATABASE_DESIGN.md §0). They live here as pure,
 * framework-independent `as const` unions so the API/domain layers can reason
 * about state without importing Prisma types. Keep them byte-for-byte in sync
 * with the Prisma enums; the schema is the persistence authority.
 */

export const USER_STATUS = ['ACTIVE', 'SUSPENDED', 'INVITED'] as const;
export type UserStatus = (typeof USER_STATUS)[number];

export const ORDER_STATUS = ['DRAFT', 'APPROVED', 'PREPARING', 'SHIPPED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export const RESERVATION_STATUS = ['ACTIVE', 'RELEASED', 'CONSUMED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUS)[number];

export const LEDGER_CHANGE_TYPE = [
  'RECEIPT',
  'SHIPMENT',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'RETURN_IN',
  'ADJUSTMENT',
] as const;
export type LedgerChangeType = (typeof LEDGER_CHANGE_TYPE)[number];

export const TRANSFER_STATUS = ['DRAFT', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUS)[number];

export const RETURN_STATUS = ['DRAFT', 'APPROVED', 'RECEIVED', 'REJECTED', 'COMPLETED'] as const;
export type ReturnStatus = (typeof RETURN_STATUS)[number];

export const RETURN_CONDITION = ['RESELLABLE', 'DAMAGED'] as const;
export type ReturnCondition = (typeof RETURN_CONDITION)[number];

export const INVOICE_STATUS = ['DRAFT', 'ISSUED', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

export const QUOTE_STATUS = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUS)[number];

export const DOCUMENT_TYPE = ['INVOICE', 'CREDIT_NOTE'] as const;
export type DocumentType = (typeof DOCUMENT_TYPE)[number];

export const JOB_STATUS = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const EMAIL_STATUS = ['QUEUED', 'SENT', 'FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUS)[number];

export const ADDRESS_TYPE = ['BILLING', 'SHIPPING'] as const;
export type AddressType = (typeof ADDRESS_TYPE)[number];

export const IMPORT_STATUS = [
  'UPLOADED',
  'VALIDATING',
  'VALIDATED',
  'IMPORTING',
  'COMPLETED',
  'VALIDATION_FAILED',
  'IMPORT_FAILED',
  'CANCELLED',
] as const;
export type ImportStatus = (typeof IMPORT_STATUS)[number];

export const IMPORT_ROW_STATUS = ['PENDING', 'VALID', 'INVALID', 'APPLIED', 'SKIPPED'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUS)[number];

export const OUTBOX_STATUS = ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUS)[number];

export const EFFECT_STATUS = ['PLANNED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN'] as const;
export type EffectStatus = (typeof EFFECT_STATUS)[number];
