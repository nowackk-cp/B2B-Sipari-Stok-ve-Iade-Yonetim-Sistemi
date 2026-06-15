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

-- 2. Backfill existing RBAC data into a single tenant, refusing to guess when a
--    role is shared across users that would belong to different companies.
DO $$
DECLARE
  default_company_id BIGINT;
  ambiguous RECORD;
BEGIN
  -- Deterministic default tenant: the lowest existing company id, or a freshly
  -- created canonical 'Default Company' when the table is empty.
  SELECT id INTO default_company_id FROM companies ORDER BY id LIMIT 1;
  IF default_company_id IS NULL THEN
    INSERT INTO companies (name, default_currency)
    VALUES ('Default Company', 'TRY')
    RETURNING id INTO default_company_id;
  END IF;

  -- Every existing user joins the default company.
  UPDATE users SET company_id = default_company_id WHERE company_id IS NULL;

  -- A role cannot be split across tenants: if it is assigned to users that would
  -- land in more than one company, fail loudly instead of silently guessing.
  FOR ambiguous IN
    SELECT ur.role_id AS role_id, COUNT(DISTINCT u.company_id) AS companies
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    GROUP BY ur.role_id
    HAVING COUNT(DISTINCT u.company_id) > 1
  LOOP
    RAISE EXCEPTION
      'TENANT_BACKFILL_AMBIGUOUS: role % is assigned to users spanning % companies; '
      'split it into one role per company before applying this migration',
      ambiguous.role_id, ambiguous.companies;
  END LOOP;

  -- Each role takes the company of the users it is assigned to; unassigned roles
  -- default to the default tenant.
  UPDATE roles r
  SET company_id = COALESCE(
    (SELECT MIN(u.company_id)
     FROM user_roles ur JOIN users u ON u.id = ur.user_id
     WHERE ur.role_id = r.id),
    default_company_id
  )
  WHERE r.company_id IS NULL;

  -- An assignment inherits its user's company (== its role's company by the
  -- ambiguity guard above).
  UPDATE user_roles ur
  SET company_id = u.company_id
  FROM users u
  WHERE u.id = ur.user_id AND ur.company_id IS NULL;

  -- Defensive final assertion before the composite FKs are added.
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
