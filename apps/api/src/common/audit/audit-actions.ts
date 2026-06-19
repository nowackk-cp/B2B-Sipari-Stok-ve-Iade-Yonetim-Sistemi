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
  // Stock Transfer Foundation: an atomic warehouse-to-warehouse transfer writes
  // its business audit row inside the SAME transaction as the two balance changes
  // and the two append-only ledger movements (ADR-007, task rule 21).
  STOCK_TRANSFERRED: 'STOCK_TRANSFERRED',
  // Customers (Customer Management Foundation): customer master-data mutations.
  // Each writes a business audit row inside the SAME transaction as the change
  // (ADR-007).
  CUSTOMER_CREATED: 'CUSTOMER_CREATED',
  CUSTOMER_UPDATED: 'CUSTOMER_UPDATED',
  CUSTOMER_DELETED: 'CUSTOMER_DELETED',
  // Orders (Order Draft Foundation): DRAFT-order lifecycle mutations. Each writes
  // a business audit row inside the SAME transaction as the change (ADR-007). No
  // stock effect occurs in this slice (no reservation/ledger writes).
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_UPDATED: 'ORDER_UPDATED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  // Orders (Order Approval + Stock Reservation Foundation): the DRAFT→APPROVED
  // transition. Its business audit row is written inside the SAME transaction as
  // the order status change AND the stock reservation (reserved++ on each
  // (product, warehouse) balance + the ACTIVE stock_reservations rows). No
  // stock_ledger movement and no on_hand change occur — a reservation only moves
  // `reserved` (INVENTORY_RULES §5, ADR-003, ADR-007).
  ORDER_APPROVED: 'ORDER_APPROVED',
  // Orders (Order Shipment / Stock Commit Foundation): the APPROVED→SHIPPED
  // transition. Its business audit row is written inside the SAME transaction as
  // the order status change AND the physical stock commit (on_hand−− & reserved−−
  // on each (product, warehouse) balance, each ACTIVE reservation → CONSUMED, and
  // one append-only SHIPMENT stock_ledger movement per line). The shipment record
  // and order_status_history append are in that same transaction (ADR-007,
  // ORDER_RULES §5, INVENTORY_RULES §4/§5).
  ORDER_SHIPPED: 'ORDER_SHIPPED',
  // Billing (Invoice/Billing Foundation): an invoice issued for a SHIPPED order.
  // Its business audit row is written inside the SAME transaction as the invoice
  // header + line snapshot + the gapless invoice_series number allocation
  // (ADR-007, INVOICE_RULES §3, ADR-006).
  INVOICE_ISSUED: 'INVOICE_ISSUED',
  // Returns (Return/Refund Foundation): a customer return raised against a SHIPPED
  // order (RETURN_CREATED — no stock effect) and its approval (RETURN_APPROVED).
  // The RETURN_APPROVED audit row is written inside the SAME transaction as the
  // return DRAFT→APPROVED transition AND the physical restock (on_hand++ on each
  // (product, warehouse) balance + one append-only RETURN_IN stock_ledger movement
  // per line; reserved unchanged). The status-history append is in that same
  // transaction (ADR-007, RETURN_RULES §3, INVENTORY_RULES §3).
  RETURN_CREATED: 'RETURN_CREATED',
  RETURN_APPROVED: 'RETURN_APPROVED',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
