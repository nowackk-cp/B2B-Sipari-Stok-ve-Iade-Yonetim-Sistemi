# Permission Tenant Isolation Review

Date: 2026-06-16

Reviewed commit: `d8c519c56513a2abd7ef26a114ec278708b19e19`

Production code changed: no. This review only inspected code, ran tests, and added this document.

Result: **FIX_REJECTED**

Mandatory reject rationale: the runtime tenant-isolation fix and composite FKs work after the migration, but the migration backfill silently assigns every legacy user to the lowest/default company. In a legacy database that already has more than one company, that is a silent tenant guess and can bind users/roles to the wrong tenant before the new DB invariants start protecting assignments.

## Scope Read

- `docs/reviews/PERMISSION_GUARD_REVIEW.md`
- Commit diff for `d8c519c56513a2abd7ef26a114ec278708b19e19`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20260616000000_rbac_company_tenant_scope/migration.sql`
- `apps/api/src/modules/authorization/permission.repository.ts`
- `apps/api/src/modules/authorization/permission.service.ts`
- `apps/api/src/modules/authorization/adapters/in-memory-permission-cache.ts`
- `apps/api/src/modules/authorization/ports/permission-cache.port.ts`
- `apps/api/src/common/auth/principal.ts`
- `apps/api/src/modules/auth/guards/jwt-auth.guard.ts`
- `apps/api/src/modules/identity/user.repository.ts`
- `packages/database/src/seed.ts`
- `packages/database/test/integration/tenant-rbac.test.ts`
- `apps/api/test/integration/authz-tenant-isolation.test.ts`
- `apps/api/test/integration/authz-permission-guard.test.ts`
- `apps/api/test/integration/authz-global-guard.test.ts`
- `apps/api/test/integration/authz-merged-metadata.test.ts`
- authentication regression integration tests under `apps/api/test/integration/auth-*.test.ts`

## Verification Summary

Initial direct run of `tenant-rbac.test.ts` failed before migration because the local test DB did not yet have `company_id`. After `prisma migrate deploy`, the same tests passed.

| Check | Result |
| --- | --- |
| Prisma validate | PASS |
| Prisma generate | PASS |
| `prisma migrate deploy` on existing test DB | PASS, applied `20260616000000_rbac_company_tenant_scope` |
| second `prisma migrate deploy` | PASS, no pending migrations |
| `db:seed` twice | PASS, both idempotent |
| tenant RBAC PostgreSQL integration tests | PASS, 8/8 |
| authz tenant isolation integration tests | PASS, 7/7 |
| PermissionGuard/global/merged authz integration tests | PASS, 35/35 |
| authentication regression integration tests | PASS, 73/73 |
| DB gate | PASS, 80/80 real PostgreSQL tests, 0 skipped |
| drift | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| verify catalog | PASS |
| typecheck | PASS, 18/18 turbo tasks |
| lint | PASS |
| format check | PASS |
| build | PASS, 10/10 turbo tasks |
| no-skip check | PASS |
| boundary check | PASS |

## Required Validations

| # | Validation | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `users.company_id`, `roles.company_id`, `user_roles.company_id` exist | PASS | `schema.prisma:242`, `schema.prisma:391`, `schema.prisma:449`; live catalog says all three are `NOT NULL`. |
| 2 | `permissions` stayed a global catalog | PASS | `Permission` has no `companyId`; `code` remains global unique at `schema.prisma:412-425`. |
| 3 | Assignable roles are company-scoped | PASS | `Role.companyId` is required and `seedCompanyRbac` upserts by `(companyId, name)` at `seed.ts:44-66`. |
| 4 | No `companyId = NULL` global assignable role remains | PASS | `roles.company_id` is `NOT NULL`; live catalog count for `roles WHERE company_id IS NULL` was `0`. |
| 5 | `SYSTEM_ADMIN` / protected role does not bypass tenant boundary | PASS | Permission guard has no role-name branch; repository requires role/user/userRole company match. Covered by `authz-tenant-isolation.test.ts:122-159`. |
| 6 | Same role name can exist in different companies | PASS | Unique index is `(company_id, name)`; test `tenant-rbac.test.ts:38-48`. No separate role code field exists. |
| 7 | Same-company duplicate role name is rejected | PASS | `roles_company_id_name_key`; test `tenant-rbac.test.ts:46-48`. |
| 8 | `user_roles(user_id, company_id)` composite FK exists | PASS | `schema.prisma:455`; migration `migration.sql:114-116`; live catalog `user_roles_user_id_company_id_fkey`. |
| 9 | `user_roles(role_id, company_id)` composite FK exists | PASS | `schema.prisma:456`; migration `migration.sql:118-120`; live catalog `user_roles_role_id_company_id_fkey`. |
| 10 | Cross-company user-role assignment is DB-rejected | PASS | `tenant-rbac.test.ts:50-87`. |
| 11 | `PermissionRepository` only returns permissions when user/role/userRole are same company | PASS | `permission.repository.ts:36-57`; API test `authz-tenant-isolation.test.ts:161-173`. |
| 12 | Forged JWT `companyId` does not grant another tenant's permission | PASS | `authz-tenant-isolation.test.ts:100-120`. |
| 13 | Principal company comes from PostgreSQL, not JWT claim | PASS | `jwt-auth.guard.ts:61-79`, `user.repository.ts:73-80`, `principal.ts:6-22`. |
| 14 | Adding permission to Company A role does not affect Company B user | PASS | API test `authz-tenant-isolation.test.ts:74-98`; DB test `tenant-rbac.test.ts:122-143`. |
| 15 | Protected/system role does not bypass tenant control | PASS | Same as #5; also `authz-permission-guard.test.ts:166-176` denies ADMIN for `system:read`. |
| 16 | Cache key contains `companyId:userId:securityVersion` | PASS | `in-memory-permission-cache.ts:30-58`; port contract `permission-cache.port.ts:8-28`. |
| 17 | Cache key cannot collide across users/tenants | PASS | `authz-tenant-isolation.test.ts:175-185`; key components are decimal bigint strings plus base64url digest, separated by `:`. |
| 18 | Second seed does not duplicate company roles | PASS | explicit `db:seed` x2 passed; `tenant-rbac.test.ts:105-120` and `seed.test.ts:35-44`. |
| 19 | Migration applies and second deploy is safe | PARTIAL | Public test DB deploy and second deploy passed; DB gate includes a fresh migrated scratch catalog test. See finding RBAC-TI-001 for unsafe multi-company legacy backfill. |
| 20 | Drift and catalog verification pass | PASS | `db:drift` and `db:verify-catalog` passed. |

## Findings

### RBAC-TI-001

Severity: **CRITICAL**

Sorun: Migration backfill cok-sirketli legacy veride fail-closed degil. `users.company_id` eklendikten sonra her mevcut user, sirket sayisina veya kullanicinin gercek is baglamina bakilmadan en dusuk id'li/default company'ye atanıyor. Ardindan role ve user_roles backfill bu yapay default uzerinden ilerliyor. Bu, kullanicilarin gercek tenant'i bilinmiyorsa sessiz tenant tahminidir.

Kanıt:

- `migration.sql:27-37` en dusuk mevcut company'yi `default_company_id` seciyor veya `Default Company` olusturuyor, sonra `UPDATE users SET company_id = default_company_id WHERE company_id IS NULL` calistiriyor.
- `migration.sql:41-52` ambiguity kontrolu kullanici `company_id` degerlerine bakiyor; fakat bu noktada tum legacy user'lar zaten ayni `default_company_id` degerine cekildigi icin cok-sirketli legacy ayrimi yakalanamaz.
- `migration.sql:56-70` roller ve atamalar bu backfill sonucuna gore company aliyor.
- Mevcut tenant RBAC testleri post-migration schema uzerinde explicit `companyId` ile calisiyor; cok-sirketli legacy migration senaryosunu kurup fail bekleyen test yok.

Yetki asimi senaryosu: Production DB'de migration oncesinde birden fazla company ve mevcut kullanicilar/roller varsa, Company B operatoru olan legacy bir kullanici sessizce Company A/default company kullanicisi haline getirilebilir. Yeni principal `companyId` degerini DB'den okudugu icin sonraki authorization ve ilerideki tenant data filtreleri bu yanlis company'yi gercek kabul eder. Boylece kullanici kendi gercek tenant'i disinda default tenant permission/data yuzeyine baglanabilir.

Onerilen duzeltme: Backfill fail-closed olmali. Ornek politika: `companies` sayisi `> 1` ve legacy `users`, `roles` veya `user_roles` satiri varsa migration `RAISE EXCEPTION` ile durmali; operator once acik bir user-to-company ve role-to-company mapping migration'i saglamali. Tek company veya bos RBAC datasinda mevcut default backfill kabul edilebilir. Ambiguity kontrolu, sentetik default atamasindan once gercek mapping datasina karsi calismali.

Gerekli test: Eski migration seviyesine kadar kurulmus scratch PostgreSQL'de iki company + legacy users/roles/user_roles olusturan migration-path testi. `20260616000000_rbac_company_tenant_scope` bu durumda `TENANT_BACKFILL_AMBIGUOUS` benzeri acik hata ile fail etmeli. Ayrica tek-company legacy data basari testi ve bos DB fresh deploy testi korunmali.

Cache invalidation gorevine etkisi: Cache invalidation bu hatayi duzeltemez; yanlis `companyId` DB truth haline gelir. Deploy sirasinda permission cache tamamen temizlenmeli, ama esas cozum migration'in yanlis tenant backfill'i commit etmeden fail etmesidir.

### RBAC-TI-002

Severity: **MEDIUM**

Sorun: `user_roles` composite FK'leri ve `role_permissions.role_id` FK'si role hard delete halinde RBAC baglantilarini sessiz cascade ile siliyor. User hard delete, mevcut `no_delete_users` trigger'i ile bloklaniyor; role hard delete icin gorunur bir `no_delete_roles` trigger'i veya soft-delete kolonu yok.

Kanıt:

- `schema.prisma:455-456` `UserRole.user` ve `UserRole.role` relations `onDelete: Cascade`.
- `schema.prisma:433` `RolePermission.role` relation `onDelete: Cascade`.
- `migration.sql:114-120` composite user-role FK'leri `ON DELETE CASCADE`.
- Canli katalog sorgusu: `user_roles_user_id_company_id_fkey` ve `user_roles_role_id_company_id_fkey` icin `confdeltype='c'`; `users_company_id_fkey` ve `roles_company_id_fkey` icin company delete `RESTRICT`.
- Rollback probe sonucu: user hard delete blocked = `true`; role hard delete sonrasi `user_rolesAfterRoleDelete=0`, `rolePermissionsAfterRoleDelete=0`.

Yetki asimi senaryosu: Bu dogrudan cross-company permission leakage yaratmiyor; daha cok auditability ve authorization-state integrity riski. Gelecekte bir role management path'i yanlislikla `role.delete` kullanirsa kullanicilarin assignment'lari ve role permission grant'leri sessizce silinir. Bu, yetki revoke gibi gorunebilir ama audit/business rule/cache invalidation olmadan oldugu icin operator tarafindan fark edilmeyen authorization-state degisimi yaratir.

Onerilen duzeltme: Role hard delete politikasini netlestir. Sistem/protected role'ler icin DB seviyesinde delete-prevention trigger'i ekle; custom role'ler icin soft delete veya servis katmaninda explicit transactional delete + audit + cache invalidation zorunlu olsun. Eger cascade bilincli tutulacaksa, role delete sadece yetkili servis fonksiyonundan gecmeli ve etkilenen user listesi transaction icinde hesaplanmali.

Gerekli test: `prisma.role.delete` protected/system role icin DB veya service seviyesinde reddedilmeli. Custom role delete desteklenecekse, affected users icin assignment/permission state degisimi auditlenmeli ve permission cache invalidation/version bump test edilmeli. User hard delete trigger testleri korunmali.

Cache invalidation gorevine etkisi: Role delete veya role permission delete, role'u tasiyan tum kullanicilarin permission cache'ini fan-out invalidate etmeli veya company/user/role bazli durable `authzVersion` artirmali. Sadece `invalidate(userId)` manuel cagrisi bu cascade path'inde otomatik tetiklenmiyor.

## Additional Notes

- `PermissionRepository` role permission cozumunu `permission -> role_permissions -> roles -> user_roles -> users` zincirinde ayni `companyId` ile filtreliyor; sadece `roleId` uzerinden tenant filtresiz join bulunmadi.
- `role_permissions` tablosunda `company_id` yok, ancak `role_id` global PK oldugu ve role satiri company-scoped oldugu icin current modelde tenant leakage bulunmadi.
- Public/system permission catalog global kalmis durumda; tenant ayrimi permission katalogunda degil, company-scoped role ve role-permission rows uzerinden saglaniyor.
- Cache key tenant ayrimi iceriyor. Invalidation politikasinin role-permission mutation/removal durumunda onceki review'deki stale-cache riski hala ayrica ele alinmali.
- Test helper `addPermissionToRole` role adiyla `findFirst` kullaniyor; coklu company testlerinde order'a bagimlilik yaratabilir. Uretim kodu degil, ama test yardimcisi `companyId_name` ile deterministik hale getirilmeli.

## Final Gate

**FIX_REJECTED**
