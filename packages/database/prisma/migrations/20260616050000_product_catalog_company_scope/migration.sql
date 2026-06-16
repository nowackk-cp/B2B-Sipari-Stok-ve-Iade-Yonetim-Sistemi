-- Product catalog company scope (TASK-011) — additive, tenant-isolated product master data.
--
-- WHY THIS EXISTS
-- A product card is master data that belongs to exactly one tenant. Until now the
-- products table had no tenant column and a GLOBAL partial-unique SKU, so two
-- companies could not reuse the same SKU and a product could not be filtered by
-- tenant. This migration makes products company-scoped at the DB layer (not merely
-- in application code):
--   • products gain a NOT NULL company_id → every product belongs to one company.
--   • the SKU unique becomes COMPOSITE + PARTIAL: `(company_id, sku) WHERE
--     deleted_at IS NULL`. Within one company an active SKU is unique; different
--     companies may reuse the same SKU; a soft-deleted product frees its SKU for
--     reuse inside its own company (matches the soft-delete key-reuse convention of
--     users/warehouses/customers/categories — DATABASE_DESIGN §16).
--   • the company FK is ON DELETE RESTRICT (never a cascade into products).
--
-- It also adds two product-card attributes the catalog foundation requires:
--   • description (nullable free text).
--   • critical_stock_threshold (nullable low-stock alert threshold). This is a
--     CATALOG attribute, NOT a stock quantity — on-hand/reserved remain in the
--     inventory module (CLAUDE rule 20). A CHECK enforces >= 0 when present.
--
-- ADDITIVE: earlier migrations are byte-for-byte untouched. Object names match
-- Prisma's generated conventions so `prisma migrate diff` reports zero new drift
-- beyond the (allowlisted) partial-unique residue.

-- 1. New columns. company_id is added NULLable first so existing rows can be
--    backfilled before the NOT NULL + FK constraints are enforced.
ALTER TABLE "products" ADD COLUMN "company_id" BIGINT;
ALTER TABLE "products" ADD COLUMN "description" TEXT;
ALTER TABLE "products" ADD COLUMN "critical_stock_threshold" BIGINT;

-- 2. Backfill products into their tenant — FAIL-CLOSED, identical policy to the
--    RBAC (20260616000000) and warehouse (20260616040000) tenant backfills: a
--    tenant is only assigned when the mapping is unambiguous (exactly one
--    company). With zero or multiple companies the migration refuses to guess and
--    aborts; it NEVER invents a default company nor picks the lowest/first one. A
--    fresh database (no products) is the only case allowed to proceed.
DO $$
DECLARE
  legacy_products BIGINT;
  company_count BIGINT;
  target_company_id BIGINT;
BEGIN
  SELECT COUNT(*) INTO legacy_products FROM products;
  IF legacy_products = 0 THEN
    RETURN; -- nothing to backfill; NOT NULL below is trivially satisfied.
  END IF;

  SELECT COUNT(*) INTO company_count FROM companies;
  IF company_count <> 1 THEN
    RAISE EXCEPTION
      'PRODUCT_TENANT_BACKFILL_AMBIGUOUS: % companies are present but legacy '
      'products exist; backfill requires exactly one company. Ship an explicit '
      'product-to-company mapping migration before applying this one.',
      company_count;
  END IF;

  SELECT id INTO target_company_id FROM companies;
  UPDATE products SET company_id = target_company_id WHERE company_id IS NULL;
END $$;

-- 3. Every row now carries a tenant → enforce NOT NULL.
ALTER TABLE "products" ALTER COLUMN "company_id" SET NOT NULL;

-- 4. Tenant index + company FK (RESTRICT, never a cascade into products).
CREATE INDEX "products_company_id_idx" ON "products"("company_id");
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Replace the GLOBAL partial-unique SKU with a COMPANY-SCOPED partial-unique,
--    preserving the index NAME (products_sku_key). The init migration created the
--    global partial unique; drop and recreate it scoped to the tenant. Still
--    PARTIAL (`WHERE deleted_at IS NULL`) so soft-deleted SKUs are reusable.
DROP INDEX "products_sku_key";
CREATE UNIQUE INDEX "products_sku_key" ON "products"("company_id", "sku") WHERE "deleted_at" IS NULL;

-- 6. Catalog attribute integrity: a critical-stock threshold, when present, must
--    be non-negative.
ALTER TABLE "products"
  ADD CONSTRAINT "products_critical_threshold_nonneg"
  CHECK ("critical_stock_threshold" IS NULL OR "critical_stock_threshold" >= 0);
