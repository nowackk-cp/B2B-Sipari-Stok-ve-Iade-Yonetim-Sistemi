-- Warehouse scope foundation (TASK-010c) — additive, tenant-isolated warehouse scope.
--
-- WHY THIS EXISTS
-- A permission answers "may this action be performed?"; a warehouse SCOPE answers
-- "on WHICH warehouse?". Holding `stock:read` must NOT, by itself, let a user touch
-- an arbitrary warehouse. Access to a warehouse comes ONLY from (1) an explicit
-- `user_warehouse_scopes` row, or (2) the protected `warehouse:scope:all`
-- permission (company-wide). No role name — ADMIN included — ever confers implicit
-- scope (SECURITY_MODEL §3, CLAUDE rule 12).
--
-- WHAT THIS MIGRATION ENFORCES AT THE DB LAYER (not merely in app code)
--   • warehouses gain a NOT NULL company_id → warehouses are tenant-scoped.
--   • user_warehouse_scopes gains a NOT NULL company_id and two COMPOSITE FKs that
--     pin user.company_id = warehouse.company_id = scope.company_id. A cross-company
--     grant (user in A, warehouse in B) is therefore physically un-insertable.
--   • Those composite FKs are ON DELETE RESTRICT: hard-deleting a user/warehouse
--     that still owns a scope is REFUSED, never a silent cascade that drops the
--     authorization grant (rule 5).
--   • The PK (user_id, warehouse_id) makes a duplicate active grant impossible.
--   • A trigger bumps the owning company's authorization_version on every scope
--     insert/update/delete, IN THE SAME TRANSACTION — so a granted/revoked scope is
--     observed immediately on every API instance and rolls back atomically with an
--     aborted transaction (consistent with PG-004).
--
-- ADDITIVE: earlier migrations are byte-for-byte untouched. Object names match
-- Prisma's generated conventions so `prisma migrate diff` reports zero new drift.

-- 1. Tenant columns added NULLable first so existing rows can be backfilled before
--    the NOT NULL + FK constraints are enforced.
ALTER TABLE "warehouses" ADD COLUMN "company_id" BIGINT;
ALTER TABLE "user_warehouse_scopes" ADD COLUMN "company_id" BIGINT;

-- 2. Backfill warehouses into their tenant — FAIL-CLOSED, identical policy to the
--    RBAC tenant backfill (20260616000000): a tenant is only assigned when the
--    mapping is unambiguous (exactly one company). With zero or multiple companies
--    the migration refuses to guess and aborts; it NEVER invents a default company
--    nor picks the lowest/first one. A fresh database (no warehouses) is the only
--    case allowed to proceed without a company.
DO $$
DECLARE
  legacy_warehouses BIGINT;
  company_count BIGINT;
  target_company_id BIGINT;
BEGIN
  SELECT COUNT(*) INTO legacy_warehouses FROM warehouses;
  IF legacy_warehouses = 0 THEN
    RETURN; -- nothing to backfill; NOT NULL below is trivially satisfied.
  END IF;

  SELECT COUNT(*) INTO company_count FROM companies;
  IF company_count <> 1 THEN
    RAISE EXCEPTION
      'WAREHOUSE_TENANT_BACKFILL_AMBIGUOUS: % companies are present but legacy '
      'warehouses exist; backfill requires exactly one company. Ship an explicit '
      'warehouse-to-company mapping migration before applying this one.',
      company_count;
  END IF;

  SELECT id INTO target_company_id FROM companies;
  UPDATE warehouses SET company_id = target_company_id WHERE company_id IS NULL;
END $$;

-- 3. Backfill scope rows from their user's tenant. Each scope's company is
--    unambiguous: it is the owning user's company. After this every scope must
--    also agree with its warehouse's company (asserted below) or the composite FK
--    would reject it. A fresh database (no scopes) is a no-op.
UPDATE "user_warehouse_scopes" uws
SET "company_id" = u."company_id"
FROM "users" u
WHERE u."id" = uws."user_id" AND uws."company_id" IS NULL;

-- Defensive: a legacy scope whose user and warehouse disagree on tenant cannot be
-- represented under the new model — fail loudly rather than drop it silently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "user_warehouse_scopes" uws
    JOIN "warehouses" w ON w."id" = uws."warehouse_id"
    WHERE uws."company_id" IS DISTINCT FROM w."company_id"
  ) THEN
    RAISE EXCEPTION
      'WAREHOUSE_SCOPE_BACKFILL_MISMATCH: a user_warehouse_scopes row does not '
      'agree with its warehouse company; an explicit mapping migration is required.';
  END IF;
END $$;

-- 4. Every row now carries a tenant → enforce NOT NULL.
ALTER TABLE "warehouses" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "user_warehouse_scopes" ALTER COLUMN "company_id" SET NOT NULL;

-- 5. The legacy granted_by was NOT NULL; relax it so removing the granter is a
--    SetNull, never a delete that the grant blocks (and so a grant can outlive its
--    creator's account lifecycle).
ALTER TABLE "user_warehouse_scopes" ALTER COLUMN "granted_by" DROP NOT NULL;

-- 6. Warehouse tenant index + composite-FK target unique + company FK (RESTRICT,
--    never a cascade into warehouses).
CREATE INDEX "warehouses_company_id_idx" ON "warehouses"("company_id");
CREATE UNIQUE INDEX "warehouses_id_company_id_key" ON "warehouses"("id", "company_id");
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Replace the single-column scope FKs (which CASCADE-deleted) with company-
--    pinned COMPOSITE FKs that RESTRICT, and re-point granted_by to SetNull.
ALTER TABLE "user_warehouse_scopes" DROP CONSTRAINT "user_warehouse_scopes_user_id_fkey";
ALTER TABLE "user_warehouse_scopes" DROP CONSTRAINT "user_warehouse_scopes_warehouse_id_fkey";
ALTER TABLE "user_warehouse_scopes" DROP CONSTRAINT "user_warehouse_scopes_granted_by_fkey";

CREATE INDEX "user_warehouse_scopes_company_id_idx" ON "user_warehouse_scopes"("company_id");

ALTER TABLE "user_warehouse_scopes" ADD CONSTRAINT "user_warehouse_scopes_user_id_company_id_fkey"
  FOREIGN KEY ("user_id", "company_id") REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_warehouse_scopes" ADD CONSTRAINT "user_warehouse_scopes_warehouse_id_company_id_fkey"
  FOREIGN KEY ("warehouse_id", "company_id") REFERENCES "warehouses"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_warehouse_scopes" ADD CONSTRAINT "user_warehouse_scopes_granted_by_fkey"
  FOREIGN KEY ("granted_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 8. Authorization-version bump on every scope change. Warehouse scope is an input
--    to the authorization decision, so a granted/revoked scope must invalidate the
--    owning company's cached authz state exactly like a role/permission change does
--    (PG-004). A moved scope bumps both the old and new tenant.
CREATE OR REPLACE FUNCTION "trg_authz_bump_user_warehouse_scopes"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "bump_company_authz_version"(OLD."company_id");
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM "bump_company_authz_version"(NEW."company_id");
    RETURN NEW;
  ELSE -- UPDATE
    PERFORM "bump_company_authz_version"(NEW."company_id");
    IF NEW."company_id" IS DISTINCT FROM OLD."company_id" THEN
      PERFORM "bump_company_authz_version"(OLD."company_id");
    END IF;
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER "authz_bump_user_warehouse_scopes"
AFTER INSERT OR UPDATE OR DELETE ON "user_warehouse_scopes"
FOR EACH ROW EXECUTE FUNCTION "trg_authz_bump_user_warehouse_scopes"();
