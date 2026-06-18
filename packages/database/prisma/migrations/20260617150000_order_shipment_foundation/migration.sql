-- Order Shipment / Stock Commit Foundation — atomic APPROVED→SHIPPED commit.
--
-- WHY THIS EXISTS
-- The orders module gains the SHIPMENT step: an APPROVED order's reserved stock is
-- physically committed in ONE transaction — for every line on_hand−, reserved−, the
-- ACTIVE reservation → CONSUMED, and one append-only SHIPMENT `stock_ledger`
-- movement (quantity negative). The order transitions APPROVED→SHIPPED and a single
-- IMMUTABLE `order_shipments` command record is written.
--
-- WHAT IT ADDS (additive only — earlier migrations are byte-for-byte untouched)
--   • `order_shipments` — one IMMUTABLE row per accepted shipment. Tenant isolation
--     is a DB invariant: the two composite FKs force order.company = warehouse.company
--     = the row's company, so a cross-company shipment is physically un-insertable.
--   • Unique `(company_id, idempotency_key)` (client idempotency replay) and unique
--     `order_id` (at most one shipment per order — last-line net behind the order row
--     lock + APPROVED→SHIPPED expected-status guard).
--   • Append-only: a `prevent_mutation` trigger blocks UPDATE/DELETE (the row is
--     write-once; idempotency replay re-reads it, never mutates it).
--
-- NOTE: orders(id, company_id) and warehouses(id, company_id) composite-unique FK
-- targets already exist (Order Draft / warehouse-scope foundations); no new target
-- index is needed here.

-- CreateTable
CREATE TABLE "order_shipments" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" BIGINT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "warehouse_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SHIPPED',
    "shipped_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT NOT NULL,
    "created_by_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_shipments_public_id_key" ON "order_shipments"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_shipments_order_id_key" ON "order_shipments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_shipments_company_id_idempotency_key_key" ON "order_shipments"("company_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "order_shipments_company_id_created_at_idx" ON "order_shipments"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "order_shipments_warehouse_id_idx" ON "order_shipments"("warehouse_id");

-- AddForeignKey
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_order_id_company_id_fkey" FOREIGN KEY ("order_id", "company_id") REFERENCES "orders"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_warehouse_id_company_id_fkey" FOREIGN KEY ("warehouse_id", "company_id") REFERENCES "warehouses"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written integrity (invisible to the Prisma structural diff): append-only
-- trigger. DATABASE_DESIGN §17 / ORDER_RULES §1a (a shipment is write-once).
-- ---------------------------------------------------------------------------

-- Append-only immutability: a shipment record is write-once. The shared
-- prevent_mutation() function (created in the init migration) blocks UPDATE and
-- DELETE at the database level, so the row can never be tampered with after the
-- atomic shipment commits.
CREATE TRIGGER no_mutation_order_shipments
  BEFORE UPDATE OR DELETE ON "order_shipments"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
