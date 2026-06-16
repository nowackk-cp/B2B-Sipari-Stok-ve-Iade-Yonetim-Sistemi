-- Authorization cache version (PG-004) — additive, multi-instance-safe authz cache versioning.
--
-- WHY THIS EXISTS
-- The effective-permission cache was keyed only by (companyId, userId, role-set
-- securityVersion). That key does NOT change when a permission is added to or
-- removed from an already-assigned role, nor when a role is dropped, nor when a
-- user is disabled — so a stale cached set could keep granting (or denying)
-- access for the whole TTL, and a process-local invalidate() never reached other
-- API instances (PERMISSION_GUARD_REVIEW PG-004). For authorization that is
-- unacceptable: a revoked grant MUST stop working immediately, on every node,
-- even if no cache was cleared.
--
-- THE MODEL
-- A single DB-sourced, company-scoped monotonic counter — `authorization_version`
-- — becomes part of the cache key. PostgreSQL is the one source of truth (a JWT
-- claim is never trusted). Every change that can alter a user's effective
-- permissions bumps the owning company's version inside the SAME transaction as
-- the change, so the bump commits or rolls back atomically with it. A reader
-- always loads the CURRENT version before a cache lookup; once the version moves,
-- the old key can never be read again on ANY instance, with or without an explicit
-- local clear. The local TTL/invalidate hooks remain as a secondary optimization.
--
-- WHAT BUMPS THE VERSION (company derived from the row / its role):
--   • user_roles      INSERT / UPDATE / DELETE        (assignment changes)
--   • role_permissions INSERT / UPDATE / DELETE        (grant changes)
--   • roles           UPDATE / DELETE                  (a role's grants change/vanish)
--   • users           UPDATE/DELETE, but ONLY when a permission-relevant column
--                     (status, deleted_at, company_id) actually changes — so the
--                     hot login path (last_login_at, failed_login_count, …) does
--                     NOT churn the whole company's cache.
-- A company_id change bumps BOTH the old and the new tenant. Cross-company: only
-- the affected company's counter moves; a bump in company A never touches B.
--
-- WHY A SEPARATE TABLE
-- The counter lives in its own `company_authz_versions` table (1 row per company)
-- rather than a column on `companies`, so authz churn never contends with or
-- rewrites business columns / `updated_at` on the company row. A row is created
-- for every company (AFTER INSERT trigger) and backfilled for existing ones.
--
-- ADDITIVE: earlier migrations are byte-for-byte untouched. The new table is the
-- only structural object (mirrored in schema.prisma so the drift gate stays
-- clean); the functions/triggers are invisible to the structural diff and are
-- asserted by scripts/verify-catalog.mjs instead.

-- 1. The per-company authorization version counter. Default 1 is the safe
--    baseline; the FIRST bump yields 2. ON DELETE CASCADE: if a company is ever
--    removed (itself RESTRICTed while it owns users/roles) its counter row goes
--    with it. This is NOT a transaction parent→child edge, so it is exempt from
--    the no-cascade catalog rule.
CREATE TABLE "company_authz_versions" (
    "company_id" BIGINT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_authz_versions_pkey" PRIMARY KEY ("company_id")
);

ALTER TABLE "company_authz_versions" ADD CONSTRAINT "company_authz_versions_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill a counter row for every existing company so a reader always finds
--    one. Idempotent (no-op on a fresh database with no companies yet).
INSERT INTO "company_authz_versions" ("company_id")
SELECT "id" FROM "companies"
ON CONFLICT ("company_id") DO NOTHING;

-- 3. Bump helper: increment one company's counter, creating the row if missing.
--    Robust to a counter row that somehow does not exist yet (first bump → 2,
--    matching "baseline 1, first change → 2"). NULL company is a no-op.
CREATE OR REPLACE FUNCTION "bump_company_authz_version"(p_company_id BIGINT)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_company_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO "company_authz_versions" AS cav ("company_id", "version", "updated_at")
  VALUES (p_company_id, 2, CURRENT_TIMESTAMP)
  ON CONFLICT ("company_id")
  DO UPDATE SET "version" = cav."version" + 1, "updated_at" = CURRENT_TIMESTAMP;
END;
$$;

-- 4. AFTER INSERT on companies → seed the baseline (1) counter row.
CREATE OR REPLACE FUNCTION "trg_authz_init_company"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "company_authz_versions" ("company_id", "version")
  VALUES (NEW."id", 1)
  ON CONFLICT ("company_id") DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "authz_init_company"
AFTER INSERT ON "companies"
FOR EACH ROW EXECUTE FUNCTION "trg_authz_init_company"();

-- 5. user_roles: every assignment change bumps the assignment's company; a moved
--    assignment bumps both the old and the new company.
CREATE OR REPLACE FUNCTION "trg_authz_bump_user_roles"()
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

CREATE TRIGGER "authz_bump_user_roles"
AFTER INSERT OR UPDATE OR DELETE ON "user_roles"
FOR EACH ROW EXECUTE FUNCTION "trg_authz_bump_user_roles"();

-- 6. role_permissions: company is derived from the owning role. The role lookup
--    is guarded (IF FOUND) so a cascade-delete of role_permissions while the role
--    itself is being deleted never errors — the roles trigger (below) covers that
--    company anyway.
CREATE OR REPLACE FUNCTION "trg_authz_bump_role_permissions"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_company BIGINT;
  v_role_id BIGINT;
BEGIN
  v_role_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."role_id" ELSE NEW."role_id" END;
  SELECT "company_id" INTO v_company FROM "roles" WHERE "id" = v_role_id;
  IF FOUND THEN
    PERFORM "bump_company_authz_version"(v_company);
  END IF;
  -- A grant re-pointed to a different role (rare; PK is (role_id, permission_id)).
  IF TG_OP = 'UPDATE' AND NEW."role_id" IS DISTINCT FROM OLD."role_id" THEN
    SELECT "company_id" INTO v_company FROM "roles" WHERE "id" = OLD."role_id";
    IF FOUND THEN
      PERFORM "bump_company_authz_version"(v_company);
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "authz_bump_role_permissions"
AFTER INSERT OR UPDATE OR DELETE ON "role_permissions"
FOR EACH ROW EXECUTE FUNCTION "trg_authz_bump_role_permissions"();

-- 7. roles: an UPDATE (incl. any soft-delete/status semantics the model may grow)
--    or a DELETE can change/withdraw the grants a member resolves, so bump the
--    role's company. INSERT of an empty role grants nothing yet → no bump. A role
--    moved to another company bumps both.
CREATE OR REPLACE FUNCTION "trg_authz_bump_roles"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "bump_company_authz_version"(OLD."company_id");
    RETURN OLD;
  ELSE -- UPDATE
    PERFORM "bump_company_authz_version"(NEW."company_id");
    IF NEW."company_id" IS DISTINCT FROM OLD."company_id" THEN
      PERFORM "bump_company_authz_version"(OLD."company_id");
    END IF;
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER "authz_bump_roles"
AFTER UPDATE OR DELETE ON "roles"
FOR EACH ROW EXECUTE FUNCTION "trg_authz_bump_roles"();

-- 8. users: a permission-relevant change (status, soft-delete, owning company)
--    must invalidate that user's cached set. Crucially we bump ONLY when such a
--    column actually changes — NOT on every UPDATE — so the high-frequency login
--    bookkeeping (last_login_at, failed_login_count, locked_until, …) does not
--    invalidate the entire company's authorization cache. A company change bumps
--    both tenants; a DELETE bumps the (old) company.
CREATE OR REPLACE FUNCTION "trg_authz_bump_users"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "bump_company_authz_version"(OLD."company_id");
    RETURN OLD;
  ELSE -- UPDATE
    IF NEW."status"     IS DISTINCT FROM OLD."status"
       OR NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
       OR NEW."company_id" IS DISTINCT FROM OLD."company_id" THEN
      PERFORM "bump_company_authz_version"(NEW."company_id");
      IF NEW."company_id" IS DISTINCT FROM OLD."company_id" THEN
        PERFORM "bump_company_authz_version"(OLD."company_id");
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER "authz_bump_users"
AFTER UPDATE OR DELETE ON "users"
FOR EACH ROW EXECUTE FUNCTION "trg_authz_bump_users"();
