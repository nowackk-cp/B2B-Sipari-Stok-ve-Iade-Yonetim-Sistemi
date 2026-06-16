/**
 * Canonical business-audit action codes for the authentication milestone
 * (TASK-009 §8). These successful, security-critical operations MUST produce a
 * business-audit row inside the same transaction as the change.
 *
 * Failed logins, invalid reset/refresh tokens and rate-limit rejections are
 * operational/security-log events (Pino), NOT business audit — they are emitted
 * outside any transaction and never recorded here.
 */
export const AUDIT_ACTIONS = {
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  ALL_SESSIONS_REVOKED: 'ALL_SESSIONS_REVOKED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_UNLOCKED: 'ACCOUNT_UNLOCKED',
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  // Catalog (TASK-011): product master-data mutations. Each writes a business
  // audit row inside the SAME transaction as the change (ADR-007).
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  PRODUCT_DELETED: 'PRODUCT_DELETED',
  // Warehouses (TASK-012): warehouse master-data mutations. Each writes a
  // business audit row inside the SAME transaction as the change (ADR-007).
  WAREHOUSE_CREATED: 'WAREHOUSE_CREATED',
  WAREHOUSE_UPDATED: 'WAREHOUSE_UPDATED',
  WAREHOUSE_DELETED: 'WAREHOUSE_DELETED',
  // Inventory (Stock Ledger Foundation): a manual stock adjustment writes its
  // business audit row inside the SAME transaction as the balance change + the
  // append-only ledger movement (ADR-007, DATABASE_DESIGN §18 "Stok düzeltme").
  STOCK_ADJUSTED: 'STOCK_ADJUSTED',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
