-- Stock Transfer Foundation — atomic single-product warehouse-to-warehouse transfer.
--
-- WHY THIS EXISTS
-- The inventory module gains an ATOMIC stock transfer: one product moved from a
-- source warehouse to a destination warehouse, WITHIN one company, in a single
-- transaction (source on_hand−, destination on_hand+, two append-only ledger
-- movements TRANSFER_OUT/TRANSFER_IN correlated by reference_id). This is
-- intentionally distinct from the planned multi-step `stock_transfers` workflow
-- (DRAFT→IN_TRANSIT→RECEIVED, TASK-019) which stays untouched here.
--
-- WHAT IT ADDS (additive only — earlier migrations are byte-for-byte untouched)
--   • `products` gains a (id, company_id) composite-unique target so the new
--     table's (product_id, company_id) FK can pin a transfer's product to the
--     transfer's company (it already exists on `warehouses`). `id` is the PK, so
--     this unique adds no new real constraint — it only enables the composite FK.
--   • `stock_transfer_records` — one IMMUTABLE row per accepted transfer. Tenant
--     isolation is a DB invariant: the three composite FKs force
--     product.company = from.company = to.company = the row's company, so a
--     cross-company transfer is physically un-insertable.
--   • CHECKs: source ≠ destination, quantity > 0.
--   • Append-only: a `prevent_mutation` trigger blocks UPDATE/DELETE (the row is
--     write-once; idempotency replay re-reads it, never mutates it).

-- products: composite-unique FK target (id, company_id). Mirrors warehouses.
CREATE UNIQUE INDEX "products_id_company_id_key" ON "products"("id", "company_id");

-- CreateTable
CREATE TABLE "stock_transfer_records" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "from_warehouse_id" BIGINT NOT NULL,
    "to_warehouse_id" BIGINT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_by_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfer_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_records_public_id_key" ON "stock_transfer_records"("public_id");

-- CreateIndex
CREATE INDEX "stock_transfer_records_company_id_created_at_idx" ON "stock_transfer_records"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_transfer_records_from_warehouse_id_idx" ON "stock_transfer_records"("from_warehouse_id");

-- CreateIndex
CREATE INDEX "stock_transfer_records_to_warehouse_id_idx" ON "stock_transfer_records"("to_warehouse_id");

-- CreateIndex
CREATE INDEX "stock_transfer_records_product_id_idx" ON "stock_transfer_records"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_records_company_id_idempotency_key_key" ON "stock_transfer_records"("company_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "stock_transfer_records" ADD CONSTRAINT "stock_transfer_records_product_id_company_id_fkey" FOREIGN KEY ("product_id", "company_id") REFERENCES "products"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_records" ADD CONSTRAINT "stock_transfer_records_from_warehouse_id_company_id_fkey" FOREIGN KEY ("from_warehouse_id", "company_id") REFERENCES "warehouses"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_records" ADD CONSTRAINT "stock_transfer_records_to_warehouse_id_company_id_fkey" FOREIGN KEY ("to_warehouse_id", "company_id") REFERENCES "warehouses"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_records" ADD CONSTRAINT "stock_transfer_records_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written integrity (invisible to the Prisma structural diff): CHECK
-- constraints + append-only trigger. DATABASE_DESIGN §17 / INVENTORY_RULES §6.
-- ---------------------------------------------------------------------------

-- Distinct warehouses + positive quantity (last-line safety net behind the API).
ALTER TABLE "stock_transfer_records"
  ADD CONSTRAINT "stock_transfer_records_src_ne_dest" CHECK ("from_warehouse_id" <> "to_warehouse_id");
ALTER TABLE "stock_transfer_records"
  ADD CONSTRAINT "stock_transfer_records_qty_pos" CHECK ("quantity" > 0);

-- Append-only immutability: a transfer record is write-once. The shared
-- prevent_mutation() function (created in the init migration) blocks UPDATE and
-- DELETE at the database level, so the row can never be tampered with after the
-- atomic transfer commits (task rule 15).
CREATE TRIGGER no_mutation_stock_transfer_records
  BEFORE UPDATE OR DELETE ON "stock_transfer_records"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
