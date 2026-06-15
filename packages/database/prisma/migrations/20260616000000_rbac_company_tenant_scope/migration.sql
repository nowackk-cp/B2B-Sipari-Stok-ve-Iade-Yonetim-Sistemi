-- RBAC company/tenant scope (TASK-010b) — additive tenant-isolation migration.
--
-- Makes users, roles and user_roles company-scoped so a user's effective
-- permissions can resolve ONLY through roles in their own company. The two
-- composite foreign keys on user_roles pin user.company_id = role.company_id =
-- user_roles.company_id, so a cross-company role assignment is rejected by
-- PostgreSQL itself — not merely by application code (PERMISSION_GUARD_REVIEW
-- PG-002, SECURITY_MODEL §2).
--
-- Additive only: earlier migrations are untouched. Object names match Prisma's
-- generated conventions so `prisma migrate diff` reports zero drift beyond the
-- pre-existing soft-delete partial-unique allowlist.

-- 1. Add the tenant columns as NULLable first so existing rows can be backfilled
--    before the NOT NULL + FK constraints are enforced.
ALTER TABLE "users" ADD COLUMN "company_id" BIGINT;
ALTER TABLE "roles" ADD COLUMN "company_id" BIGINT;
ALTER TABLE "user_roles" ADD COLUMN "company_id" BIGINT;

-- 2. Backfill existing RBAC data into its tenant — FAIL-CLOSED. Legacy data is
--    only backfilled when the tenant mapping is unambiguous (exactly one company
--    exists). With zero or multiple companies the migration refuses to guess and
--    aborts; an operator must first ship an explicit user→company / role→company
--    mapping migration. The migration NEVER silently picks a "default"/lowest
--    company (RBAC-TI-001).
DO $$
DECLARE
  legacy_rows BIGINT;
  company_count BIGINT;
  target_company_id BIGINT;
BEGIN
  -- Is there any legacy RBAC data that now needs a tenant assigned?
  SELECT
    (SELECT COUNT(*) FROM users) +
    (SELECT COUNT(*) FROM roles) +
    (SELECT COUNT(*) FROM user_roles)
  INTO legacy_rows;

  -- Empty RBAC data (fresh database): nothing to backfill. The NOT NULL
  -- constraints added below are then trivially satisfied — even when no company
  -- exists yet. This is the ONLY case allowed to proceed without a company.
  IF legacy_rows = 0 THEN
    RETURN;
  END IF;

  -- Legacy data EXISTS, so every row must receive a tenant. The mapping is only
  -- unambiguous when EXACTLY ONE company is present:
  --   • 0 companies  → there is no tenant to assign these rows to;
  --   • 2+ companies → which tenant each legacy row belongs to is unknowable here.
  -- In both cases fail loudly and require an explicit mapping migration first.
  -- We deliberately do NOT create a default company, nor pick the lowest/first
  -- company, nor guess from existing assignments.
  SELECT COUNT(*) INTO company_count FROM companies;

  IF company_count <> 1 THEN
    RAISE EXCEPTION
      'TENANT_BACKFILL_AMBIGUOUS: % companies are present but legacy users/roles/'
      'user_roles exist; backfill requires exactly one company. Ship an explicit '
      'user-to-company and role-to-company mapping migration before applying this one.',
      company_count;
  END IF;

  -- Unambiguous: a single tenant owns all legacy RBAC rows.
  SELECT id INTO target_company_id FROM companies;

  UPDATE users      SET company_id = target_company_id WHERE company_id IS NULL;
  UPDATE roles      SET company_id = target_company_id WHERE company_id IS NULL;
  UPDATE user_roles SET company_id = target_company_id WHERE company_id IS NULL;

  -- Defensive final assertion before the composite FKs are added: every
  -- assignment must agree with BOTH its user and its role company. With a single
  -- tenant this always holds; the check guards against any future change that
  -- could let these three updates diverge.
  IF EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.company_id <> u.company_id OR ur.company_id <> r.company_id
  ) THEN
    RAISE EXCEPTION
      'TENANT_BACKFILL_MISMATCH: a user_roles row does not agree with its user/role company';
  END IF;
END $$;

-- 3. Now that every row carries a tenant, enforce NOT NULL.
ALTER TABLE "users" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "roles" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "user_roles" ALTER COLUMN "company_id" SET NOT NULL;

-- 4. Drop the constraints superseded by the tenant model: the single-column
--    user_roles FKs (replaced by composite FKs) and the global role-name unique
--    (replaced by a per-company unique).
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_role_id_fkey";
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey";
DROP INDEX "roles_name_key";

-- 5. Tenant indexes + composite-FK target uniques.
CREATE INDEX "users_company_id_idx" ON "users"("company_id");
CREATE UNIQUE INDEX "users_id_company_id_key" ON "users"("id", "company_id");
CREATE INDEX "roles_company_id_idx" ON "roles"("company_id");
CREATE UNIQUE INDEX "roles_company_id_name_key" ON "roles"("company_id", "name");
CREATE UNIQUE INDEX "roles_id_company_id_key" ON "roles"("id", "company_id");
CREATE INDEX "user_roles_company_id_idx" ON "user_roles"("company_id");

-- 6. Foreign keys. Company deletion is RESTRICTed (never a dangerous cascade
--    into RBAC). The two composite FKs enforce same-company assignment.
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_company_id_fkey"
  FOREIGN KEY ("user_id", "company_id") REFERENCES "users"("id", "company_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_company_id_fkey"
  FOREIGN KEY ("role_id", "company_id") REFERENCES "roles"("id", "company_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
