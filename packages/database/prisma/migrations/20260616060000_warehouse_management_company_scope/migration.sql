-- Warehouse management company scope (TASK-012) — tenant-scoped warehouse code.
--
-- WHY THIS EXISTS
-- The warehouse master-data management API needs the same multi-tenant code
-- semantics the catalog already gives products: a warehouse `code` must be
-- unique only WITHIN a company, two companies may reuse the same code, and a
-- soft-deleted warehouse frees its code for reuse inside its own company.
--
-- Until now the init migration created `warehouses_code_key` as a GLOBAL partial
-- unique (`("code") WHERE deleted_at IS NULL`), so two tenants could not share a
-- code. The warehouse-scope foundation (20260616040000) added the NOT NULL
-- `company_id` + the (id, company_id) composite-FK target, but left the code
-- unique global. This migration makes the code unique COMPANY-SCOPED at the DB
-- layer (not merely in application code), exactly mirroring the products SKU
-- change (20260616050000):
--   • the code unique becomes COMPOSITE + PARTIAL: `(company_id, code) WHERE
--     deleted_at IS NULL`. Within one company an active code is unique; different
--     companies may reuse the same code; a soft-deleted warehouse frees its code
--     for reuse inside its own company (DATABASE_DESIGN §16 soft-delete reuse).
--
-- ADDITIVE: earlier migrations are byte-for-byte untouched. The index NAME is
-- preserved (`warehouses_code_key`) so `prisma migrate diff` reports zero new
-- drift beyond the (allowlisted) partial-unique residue.

-- Replace the GLOBAL partial-unique code with a COMPANY-SCOPED partial-unique,
-- preserving the index NAME. Still PARTIAL (`WHERE deleted_at IS NULL`) so a
-- soft-deleted warehouse's code is reusable within the same company.
DROP INDEX "warehouses_code_key";
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("company_id", "code") WHERE "deleted_at" IS NULL;
