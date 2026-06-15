-- RBAC user_roles delete-restrict (RBAC-TI-002) — additive, fail-closed.
--
-- WHY THIS EXISTS
-- `20260616000000_rbac_company_tenant_scope` created the two composite foreign
-- keys that pin every assignment to a single tenant:
--   user_roles(user_id,  company_id) → users(id,  company_id)
--   user_roles(role_id,  company_id) → roles(id,  company_id)
-- but it created them ON DELETE CASCADE. A hard DELETE of a user or a role would
-- then SILENTLY erase its user_roles assignments — an authorization-state change
-- with no audit, no business-rule check and no cache invalidation
-- (PERMISSION_TENANT_ISOLATION_REVIEW RBAC-TI-002). The project's RBAC / audit /
-- soft-delete model forbids that: orders, invoices, ledger and audit are never
-- deleted, master data is soft-deleted, and `users` already carry a
-- `no_delete_users` BEFORE DELETE trigger. `roles`, however, have no such trigger,
-- so the role-side CASCADE is the live risk.
--
-- THE FIX
-- Re-create BOTH composite FKs ON DELETE RESTRICT. The DB now REFUSES to delete a
-- user or role that still owns assignments instead of quietly cascading. The
-- assignment must be removed first (an explicit, auditable act). RESTRICT is also
-- what the catalog gate (scripts/verify-catalog.mjs) already requires of every
-- other transaction parent→child edge.
--
-- WHY ADDITIVE (and not an in-place edit of 20260616000000)
-- Prisma keys applied migrations by NAME and never re-runs an already-applied
-- file. Editing 20260616000000 in place would leave every database that already
-- applied it (its checksum is also pinned by the 20260616010000 guard) on the old
-- CASCADE FKs while `migrate deploy` reports "No pending migrations" — the risk
-- would survive undetected. A NEW migration is pending on those databases, so the
-- corrected delete action actually gets applied. The tenant-scope migration and
-- the checksum-guard migration are therefore left BYTE-FOR-BYTE untouched.
--
-- SCOPE
-- Only the ON DELETE action of the two user_roles composite FKs changes. The FK
-- columns, referenced columns, names and ON UPDATE CASCADE are preserved, so the
-- tenant composite-FK guarantee (cross-company assignment rejected by PostgreSQL)
-- is fully retained. companies → users/roles stay ON DELETE RESTRICT (untouched).
-- No existing row is read or rewritten.

-- 1+2. user_roles → users: drop the CASCADE FK and re-add it ON DELETE RESTRICT.
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_company_id_fkey";
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_company_id_fkey"
  FOREIGN KEY ("user_id", "company_id") REFERENCES "users"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3+4. user_roles → roles: drop the CASCADE FK and re-add it ON DELETE RESTRICT.
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_role_id_company_id_fkey";
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_company_id_fkey"
  FOREIGN KEY ("role_id", "company_id") REFERENCES "roles"("id", "company_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
