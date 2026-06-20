-- Return Invoice / Credit Note Foundation — issue a credit note for an APPROVED return.
--
-- WHY THIS EXISTS
-- The billing module gains a new write path: `POST /returns/:id/credit-note` issues
-- ONE credit note (refund invoice) for an APPROVED return of an invoiced order, in a
-- single transaction — the credit note header, its line snapshot (computed from the
-- return quantities × the original order/invoice line price+VAT), the gapless number
-- allocation (a dedicated `invoice_series` row, series_code 'CRN') and the business
-- audit all commit or roll back together. The credit note is created directly as
-- ISSUED. A transaction rollback rolls back the series next_number, so a number is
-- never burned (ADR-006).
--
-- WHY A DEDICATED TABLE (not invoices.doc_type='CREDIT_NOTE')
-- The invoices table carries a PARTIAL unique `invoices_company_id_order_id_active_key`
-- (one ACTIVE invoice per order). A credit note that also carries its order_id would
-- collide with the order's original invoice. Storing credit notes in their own table
-- keeps the invoice issue behaviour and its uniqueness byte-for-byte untouched while
-- giving credit notes return-centric uniqueness `(company_id, return_id)`.
--
-- WHAT IT ADDS (additive only — earlier migrations are byte-for-byte untouched)
--   • credit_notes / credit_note_items tables. company_id is carried explicitly and
--     the return/order/customer/warehouse FKs are company-pinned composites, so a
--     cross-company credit note is physically un-insertable.
--   • Unique (company_id, idempotency_key) — at most one credit note per client key.
--   • Unique (company_id, series_id, fiscal_year, credit_note_number) — gapless
--     number uniqueness within a series (A-01 / ADR-006).
--   • PARTIAL unique (company_id, return_id) WHERE status <> 'VOID' — at most one
--     ACTIVE credit note per return (a re-issue after VOID stays possible). The
--     Prisma datamodel models a plain unique with the same NAME; the structural drift
--     diff therefore sees a plain unique (allowlisted in scripts/drift-eval.mjs),
--     while the predicate itself is asserted by scripts/verify-catalog.mjs.
--   • no_delete_credit_notes trigger — a credit note is a financial document and is
--     never deleted (CLAUDE rule 6), like invoices.

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" BIGINT NOT NULL,
    "series_id" BIGINT NOT NULL,
    "credit_note_number" BIGINT NOT NULL,
    "credit_note_no" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "return_id" BIGINT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "original_invoice_id" BIGINT NOT NULL,
    "customer_id" BIGINT NOT NULL,
    "warehouse_id" BIGINT NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'ISSUED',
    "currency" CHAR(3) NOT NULL DEFAULT 'TRY',
    "subtotal_amount" BIGINT NOT NULL DEFAULT 0,
    "tax_amount" BIGINT NOT NULL DEFAULT 0,
    "grand_total_amount" BIGINT NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_items" (
    "id" BIGSERIAL NOT NULL,
    "credit_note_id" BIGINT NOT NULL,
    "company_id" BIGINT NOT NULL,
    "return_item_id" BIGINT NOT NULL,
    "order_item_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "unit_price_amount" BIGINT NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL,
    "line_subtotal_amount" BIGINT NOT NULL,
    "line_tax_amount" BIGINT NOT NULL,
    "line_total_amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_public_id_key" ON "credit_notes"("public_id");

-- CreateIndex
CREATE INDEX "credit_notes_company_id_idx" ON "credit_notes"("company_id");

-- CreateIndex
CREATE INDEX "credit_notes_return_id_idx" ON "credit_notes"("return_id");

-- CreateIndex
CREATE INDEX "credit_notes_order_id_idx" ON "credit_notes"("order_id");

-- CreateIndex
CREATE INDEX "credit_notes_original_invoice_id_idx" ON "credit_notes"("original_invoice_id");

-- CreateIndex
CREATE INDEX "credit_notes_customer_id_idx" ON "credit_notes"("customer_id");

-- CreateIndex
CREATE INDEX "credit_notes_warehouse_id_idx" ON "credit_notes"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_company_id_idempotency_key_key" ON "credit_notes"("company_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_company_id_series_id_fiscal_year_credit_note_n_key" ON "credit_notes"("company_id", "series_id", "fiscal_year", "credit_note_number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_id_company_id_key" ON "credit_notes"("id", "company_id");

-- CreateIndex
CREATE INDEX "credit_note_items_credit_note_id_idx" ON "credit_note_items"("credit_note_id");

-- CreateIndex
CREATE INDEX "credit_note_items_product_id_idx" ON "credit_note_items"("product_id");

-- CreateIndex
CREATE INDEX "credit_note_items_company_id_idx" ON "credit_note_items"("company_id");

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "invoice_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_return_id_company_id_fkey" FOREIGN KEY ("return_id", "company_id") REFERENCES "returns"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_order_id_company_id_fkey" FOREIGN KEY ("order_id", "company_id") REFERENCES "orders"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_original_invoice_id_fkey" FOREIGN KEY ("original_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_company_id_fkey" FOREIGN KEY ("customer_id", "company_id") REFERENCES "customers"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_warehouse_id_company_id_fkey" FOREIGN KEY ("warehouse_id", "company_id") REFERENCES "warehouses"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_credit_note_id_fkey" FOREIGN KEY ("credit_note_id", "company_id") REFERENCES "credit_notes"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_product_id_company_id_fkey" FOREIGN KEY ("product_id", "company_id") REFERENCES "products"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written integrity (invisible to the Prisma structural diff): the active
-- credit-note-per-return PARTIAL unique index + the delete-prevention trigger.
-- Prisma cannot model the predicate, so the datamodel declares a plain unique with
-- this exact NAME; the diff residue is allowlisted (drift-eval.mjs) and the
-- predicate is asserted by verify-catalog.mjs.
-- ---------------------------------------------------------------------------

-- At most one ACTIVE (non-VOID) credit note per (company, return): a duplicate
-- credit note for the same return is blocked, while a re-issue after a VOID stays
-- possible (mirrors invoices_company_id_order_id_active_key).
CREATE UNIQUE INDEX "credit_notes_company_id_return_id_active_key"
  ON "credit_notes"("company_id", "return_id")
  WHERE "status" <> 'VOID';

-- A credit note is a financial document and is never deleted (CLAUDE rule 6), like
-- invoices. The prevent_delete() function already exists (init gate migration).
CREATE TRIGGER no_delete_credit_notes BEFORE DELETE ON "credit_notes" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
