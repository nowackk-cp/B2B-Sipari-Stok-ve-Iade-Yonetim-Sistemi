-- Customer company scope (Customer Management Foundation) — tenant-isolated customer master data.
--
-- WHY THIS EXISTS
-- A customer card is master data that belongs to exactly one tenant. Until now the
-- customers table had no tenant column and a GLOBAL partial-unique code, so two
-- companies could not reuse the same customer code and a customer could not be
-- filtered by tenant. This migration makes customers company-scoped at the DB layer
-- (not merely in application code), exactly mirroring the products SKU change
-- (20260616050000) and the warehouse code change (20260616060000):
--   • customers gain a NOT NULL company_id → every customer belongs to one company.
--   • the code unique becomes COMPOSITE + PARTIAL: `(company_id, code) WHERE
--     deleted_at IS NULL`. Within one company an active code is unique; different
--     companies may reuse the same code; a soft-deleted customer frees its code for
--     reuse inside its own company (matches the soft-delete key-reuse convention of
--     users/warehouses/products/categories — DATABASE_DESIGN §16).
--   • the company FK is ON DELETE RESTRICT (never a cascade into customers).
--
-- ADDITIVE: earlier migrations are byte-for-byte untouched. Object names match
-- Prisma's generated conventions so `prisma migrate diff` reports zero new drift
-- beyond the (allowlisted) partial-unique residue.

-- 1. New column. company_id is added NULLable first so existing rows can be
--    backfilled before the NOT NULL + FK constraints are enforced.
ALTER TABLE "customers" ADD COLUMN "company_id" BIGINT;

-- 2. Backfill customers into their tenant — FAIL-CLOSED, identical policy to the
--    RBAC (20260616000000), warehouse (20260616040000) and product
--    (20260616050000) tenant backfills: a tenant is only assigned when the mapping
--    is unambiguous (exactly one company). With zero or multiple companies the
--    migration refuses to guess and aborts; it NEVER invents a default company nor
--    picks the lowest/first one. A fresh database (no customers) is the only case
--    allowed to proceed.
DO $$
DECLARE
  legacy_customers BIGINT;
  company_count BIGINT;
  target_company_id BIGINT;
BEGIN
  SELECT COUNT(*) INTO legacy_customers FROM customers;
  IF legacy_customers = 0 THEN
    RETURN; -- nothing to backfill; NOT NULL below is trivially satisfied.
  END IF;

  SELECT COUNT(*) INTO company_count FROM companies;
  IF company_count <> 1 THEN
    RAISE EXCEPTION
      'CUSTOMER_TENANT_BACKFILL_AMBIGUOUS: % companies are present but legacy '
      'customers exist; backfill requires exactly one company. Ship an explicit '
      'customer-to-company mapping migration before applying this one.',
      company_count;
  END IF;

  SELECT id INTO target_company_id FROM companies;
  UPDATE customers SET company_id = target_company_id WHERE company_id IS NULL;
END $$;

-- 3. Every row now carries a tenant → enforce NOT NULL.
ALTER TABLE "customers" ALTER COLUMN "company_id" SET NOT NULL;

-- 4. Tenant index + company FK (RESTRICT, never a cascade into customers).
CREATE INDEX "customers_company_id_idx" ON "customers"("company_id");
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Replace the GLOBAL partial-unique code with a COMPANY-SCOPED partial-unique,
--    preserving the index NAME (customers_code_key). The init migration created the
--    global partial unique; drop and recreate it scoped to the tenant. Still
--    PARTIAL (`WHERE deleted_at IS NULL`) so soft-deleted codes are reusable.
DROP INDEX "customers_code_key";
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("company_id", "code") WHERE "deleted_at" IS NULL;
