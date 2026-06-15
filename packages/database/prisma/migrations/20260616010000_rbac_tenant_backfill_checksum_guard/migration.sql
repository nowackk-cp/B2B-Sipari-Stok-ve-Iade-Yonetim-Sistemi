-- RBAC tenant-backfill checksum guard (BACKFILL-001) — additive, fail-closed.
--
-- WHY THIS EXISTS
-- `20260616000000_rbac_company_tenant_scope` was corrected IN PLACE: an earlier
-- UNSAFE version silently guessed a tenant for legacy RBAC rows (lowest company
-- id, or a freshly invented "Default Company"). The fixed version refuses to
-- guess and fails closed (TENANT_BACKFILL_AMBIGUOUS). Editing the file is only
-- safe for databases that have NOT yet applied that migration: Prisma keys
-- applied migrations by name, so a database that already ran the UNSAFE SQL
-- records it as applied, never re-runs the corrected SQL, and
-- `migrate deploy` happily reports "No pending migrations to apply" — leaving
-- the unsafe silent tenant assignment committed and undetected
-- (PERMISSION_TENANT_BACKFILL_REVIEW BACKFILL-001).
--
-- This additive migration closes that gap. Because it is a NEW migration name,
-- it IS pending on any such database and runs under `migrate deploy`. It
-- verifies — against Prisma's own `_prisma_migrations` bookkeeping — that the
-- tenant-scope migration recorded on this database is the FIXED/safe file, and
-- aborts the deploy fail-closed otherwise.
--
-- It does NOT attempt automatic remediation. A database that ran the unsafe
-- backfill may already hold a silently-guessed, WRONG tenant mapping; the
-- correct user→company / role→company mapping cannot be safely reconstructed
-- here (the information that would disambiguate it was never captured). The only
-- safe paths are an explicit, operator-authored remediation migration or
-- recreating the (pre-production) branch database. So this guard only DETECTS
-- and STOPS; it changes no tenant data and makes no schema change (it is
-- therefore invisible to the drift gate).
--
-- CHECKSUMS (SHA-256 of the migration.sql file == Prisma's stored checksum):
--   fixed/safe   fc3b7c2ca43fc8612dd75231b73fb33d064b74e4f2fa0703ad716113fc3b399c
--   old/unsafe   322646d9ac57662d6721e74feb44e17a4f2bc557b522107fadb5131f5b2a8aee

DO $$
DECLARE
  rec RECORD;
  -- SHA-256 of the corrected migration file currently on disk; this is exactly
  -- what Prisma stores in `_prisma_migrations.checksum` when it applies it.
  fixed_checksum  CONSTANT TEXT := 'fc3b7c2ca43fc8612dd75231b73fb33d064b74e4f2fa0703ad716113fc3b399c';
  -- SHA-256 of the original UNSAFE migration file (git d8c519c) that silently
  -- guessed a tenant. Any database carrying this checksum ran the bad backfill.
  unsafe_checksum CONSTANT TEXT := '322646d9ac57662d6721e74feb44e17a4f2bc557b522107fadb5131f5b2a8aee';
BEGIN
  -- This guard is only meaningful during a real `migrate deploy` / `migrate dev`,
  -- where Prisma has created and populated `_prisma_migrations`. The drift gate
  -- replays these files via `prisma migrate diff --from-migrations` to build a
  -- shadow schema WITHOUT that bookkeeping table; there is nothing to verify
  -- then, so skip silently. (A real deploy ALWAYS has this table, so skipping
  -- here never weakens the production guarantee.)
  IF to_regclass('_prisma_migrations') IS NULL THEN
    RAISE NOTICE
      'tenant-backfill checksum guard: _prisma_migrations absent (shadow/diff replay); nothing to verify.';
    RETURN;
  END IF;

  SELECT m.checksum, m.finished_at, m.rolled_back_at
  INTO rec
  FROM "_prisma_migrations" m
  WHERE m.migration_name = '20260616000000_rbac_company_tenant_scope';

  -- The tenant-scope migration sorts BEFORE this one, so in any ordered apply it
  -- is already recorded. A missing row therefore means the history was
  -- hand-edited / partially applied and we cannot positively verify the safe
  -- backfill ran. Fail closed rather than assume.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM: migration '
      '20260616000000_rbac_company_tenant_scope is not recorded in _prisma_migrations; '
      'cannot verify the tenant backfill was the fixed/safe version. Manual remediation required.';
  END IF;

  -- It must be applied and not rolled back; an in-progress or rolled-back row
  -- means the backfill state is indeterminate.
  IF rec.finished_at IS NULL OR rec.rolled_back_at IS NOT NULL THEN
    RAISE EXCEPTION
      'TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM: migration '
      '20260616000000_rbac_company_tenant_scope is recorded but not in a clean applied state '
      '(finished_at=%, rolled_back_at=%). Manual remediation required.',
      rec.finished_at, rec.rolled_back_at;
  END IF;

  -- The recorded checksum is the original UNSAFE file: the silent-guess backfill
  -- already ran on this database. We CANNOT auto-repair it — the correct tenant
  -- mapping is unrecoverable here. Stop the deploy; require manual remediation
  -- or a branch-DB recreate.
  IF rec.checksum = unsafe_checksum THEN
    RAISE EXCEPTION
      'TENANT_BACKFILL_UNSAFE_PRIOR_MIGRATION_APPLIED: this database applied the OLD unsafe '
      '20260616000000_rbac_company_tenant_scope (checksum %), which silently guessed a tenant '
      'for legacy RBAC rows. Its tenant mapping may be wrong and cannot be safely auto-corrected. '
      'Recreate the (pre-production) branch database, or ship an explicit operator-authored '
      'remediation migration; this guard intentionally performs no automatic tenant repair.',
      rec.checksum;
  END IF;

  -- Anything other than the known fixed checksum is an unrecognised version of
  -- the tenant-scope migration (locally modified, a future edit, or corruption).
  -- We cannot certify it as the safe backfill, so fail closed.
  IF rec.checksum <> fixed_checksum THEN
    RAISE EXCEPTION
      'TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM: 20260616000000_rbac_company_tenant_scope '
      'has unrecognised checksum % (expected the fixed/safe %). Cannot verify the tenant backfill '
      'was the fail-closed version; manual remediation required.',
      rec.checksum, fixed_checksum;
  END IF;

  -- checksum == fixed_checksum → the fail-closed backfill is what ran. Pass.
  RAISE NOTICE 'tenant-backfill checksum guard: verified fixed/safe tenant-scope migration (%).', rec.checksum;
END $$;
