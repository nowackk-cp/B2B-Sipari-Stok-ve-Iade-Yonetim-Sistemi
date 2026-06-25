# Permission Guard Review

Date: 2026-06-15

Reviewed commit: `ea8b9b1 feat(authz): add permission guard foundation (TASK-010)`

Production code changed: no. This review only inspected code, ran tests, and added this document.

Result: **REJECTED_PERMISSION_GUARD**

Mandatory reject conditions hit:

- PermissionGuard is not actually bound into the production request chain.
- RBAC has no company/tenant boundary, so cross-company permission leakage cannot be prevented or negatively tested in the current model.

## Scope Read

- `docs/reviews/AUTHENTICATION_FOUNDATION_REVIEW_FOLLOWUP.md`
- `docs/architecture/SECURITY_MODEL.md`
- `docs/PERMISSION_MATRIX.md`
- `packages/domain/src/rbac.ts`
- `apps/api/src/modules/authorization/**`
- `apps/api/test/support/test-authz.controller.ts`
- `apps/api/test/support/test-authz.module.ts`
- `apps/api/test/unit/permission-guard.test.ts`
- `apps/api/test/integration/authz-permission-guard.test.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/common/auth/principal.ts`
- `apps/api/src/modules/auth/**` principal/token/auth guard paths
- Prisma RBAC/user/company models and related DB integration tests

## Verification Run

Environment used for DB tests:
`DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_auth_test?schema=public`

PostgreSQL reachability: `Test-NetConnection 127.0.0.1:55432` returned `TcpTestSucceeded=True`.

| Check | Result |
| --- | --- |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/permission-guard.test.ts` | PASS, 11/11 tests |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/authz-permission-guard.test.ts` | PASS, 15/15 real PostgreSQL tests |
| `pnpm.cmd --filter @b2b/api test:integration` | PASS, API gate: 99/99 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd --filter @b2b/database test:database-gate` | PASS, DB gate: 72/72 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd check:no-skip` | PASS, no focused/skipped tests found |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |

The integration gates are fail-closed wrappers and reported real PostgreSQL execution with zero skipped tests.

## Confirmed Behaviors

- Effective permissions are loaded from PostgreSQL through `user_roles -> role_permissions -> permissions`, not from JWT claims (`apps/api/src/modules/authorization/permission.repository.ts:23`).
- Forged JWT `roles` and `permissions` claims did not grant access in the real PostgreSQL authz test (`apps/api/test/integration/authz-permission-guard.test.ts:144`).
- No runtime role-name bypass was found in `PermissionGuard`; ADMIN was denied `system:read` by permission check (`apps/api/test/integration/authz-permission-guard.test.ts:158`).
- Missing authentication returns 401 and missing permission returns 403 in the test-only protected controller.
- Multiple required permissions are enforced as all-of via `required.every(...)` (`apps/api/src/modules/authorization/permission.service.ts:52`).
- Disabled users are rejected by `JwtAuthGuard` before authorization (`apps/api/src/modules/auth/guards/jwt-auth.guard.ts:49`); a soft-deleted user token is covered by auth integration (`apps/api/test/integration/auth-contract.test.ts:85`).
- Current auth responses use hand-written contracts and `toUserProfileView`, not Prisma model spreading (`apps/api/src/modules/identity/user-view.ts:9`, `packages/contracts/src/auth.ts:11`).

## Findings

### PG-001

Severity: **BLOCKER**

Sorun: `PermissionGuard` production request zincirine gercekten baglanmis degil. `AppModule` sadece `AuthorizationModule` import ediyor; `APP_GUARD` yok ve production controllerlarda `PermissionGuard` kullanimi yok.

Kanıt:

- `AppModule` imports `AuthorizationModule`, but providers only include `APP_FILTER` and `APP_INTERCEPTOR`: `apps/api/src/app.module.ts:15`.
- `AuthorizationModule` provides/exports `PermissionGuard`, but does not bind it globally: `apps/api/src/modules/authorization/authorization.module.ts:18`.
- `TestAuthzModule` explicitly says it is test-only and never imported by production `AppModule`: `apps/api/test/support/test-authz.module.ts:7`.
- `rg PermissionGuard apps/api/src` finds only the authorization module/guard/decorator comments, not production controller usage.

Yetki aşımı senaryosu: TASK-010a veya sonraki feature module bir mutating route ekler ve `@RequirePermissions`/`PermissionGuard` unutulursa route sadece varsa auth guard ile calisir ya da tamamen acik kalir. Bu, protected route icin permission sahibi olmayan kullanicinin islem yapabilmesiyle sonuclanir.

Önerilen düzeltme: Permission enforcement icin production seviyesinde zorunlu bir baglama secilmeli: global `APP_GUARD` + net guard sirasi, veya her production controller icin zorunlu `@UseGuards(JwtAuthGuard, PermissionGuard)` politikasini CI scanner ile enforcement. Public/authenticated-only/protected route ayrimi explicit decoratorlarla yapilmali.

Gerekli test: `AppModule` uzerinden production controllerlari enumerate eden bir test; her protected route icin 401/403/200 senaryosu ve missing `PermissionGuard` fixture'inin CI'da fail ettigi coverage testi.

TASK-010a etkisi: **Reject/blocker.** Grant ceiling baslamadan once production enforcement zinciri kanitlanmali.

### PG-002

Severity: **CRITICAL**

Sorun: RBAC veri modeli ve permission sorgusu company/tenant izolasyonu tasimiyor. `User`, `Role`, `UserRole`, `RolePermission`, `Permission` modellerinde tenant eslestirmesi yok; `PermissionRepository` yalniz `userId` ve active user filtresiyle permission donduruyor.

Kanıt:

- `User` modelinde `companyId`/`tenantId` yok: `packages/database/prisma/schema.prisma:232`.
- `Role` global `name @unique` ile tanimli, company/tenant alani yok: `packages/database/prisma/schema.prisma:373`.
- `UserRole` sadece `(userId, roleId)` tutuyor: `packages/database/prisma/schema.prisma:419`.
- `PermissionRepository.loadEffectivePermissionCodes` sorgusu sadece `userId`, `status`, `deletedAt` filtreliyor; role/user company esitligi kontrolu yok: `apps/api/src/modules/authorization/permission.repository.ts:23`.
- `rg company|tenant` RBAC alanlarinda eslesme bulmadi; `companyId` yalniz billing/import gibi diger domain modellerinde var.

Yetki aşımı senaryosu: Company A kullanicisina Company B'ye ait veya B icin tasarlanmis bir rol atanirsa mevcut guard bu rolun permissionlarini kabul eder. Modelde rolun hangi company'ye ait oldugu bilinmedigi icin guard bunu reddedemez. Bu, cross-company permission leakage reject kosuludur.

Önerilen düzeltme: User ve tenant-scoped role/user-role modeline explicit `companyId`/`tenantId` eklenmeli. System/global roller ayri ve belgeli bir scope ile temsil edilmeli. Permission sorgusu `role.companyId = user.companyId` veya explicit global-system-role allowlist sartiyla calismali. DB seviyesinde composite FK/unique constraintler ve service seviyesinde atama denetimleri eklenmeli.

Gerekli test: Gercek PostgreSQL negatif test: Company A user, Company B role, role permission mevcut, user-role atamasi hatali/manuel yapilmis olsa bile protected route `403`; ayni company role `200`; global/system role davranisi belgeli ve testli.

TASK-010a etkisi: **Reject/critical.** Grant ceiling tenant siniri olmadan guvenli uygulanamaz.

### PG-003

Severity: **HIGH**

Sorun: Controller ve handler seviyesindeki `@RequirePermissions` metadata birlesmiyor; handler metadata controller metadata'sini eziyor. Bu, class-level base permission kullanan controllerlarda eksik enforcement yaratir.

Kanıt:

- `PermissionGuard` `reflector.getAllAndOverride(...)` kullaniyor: `apps/api/src/modules/authorization/guards/permission.guard.ts:36`.
- Test controller sadece method-level metadata kullaniyor; class+handler union testi yok: `apps/api/test/support/test-authz.controller.ts:22`.
- Unit coverage scanner sadece handler metadata okuyor: `apps/api/test/unit/permission-guard.test.ts:195`.

Yetki aşımı senaryosu: Controller seviyesinde `@RequirePermissions('warehouse:read')`, handler seviyesinde `@RequirePermissions('stock:adjust')` varsa, sadece `stock:adjust` sahibi kullanici `warehouse:read` olmadan handler'a erisebilir.

Önerilen düzeltme: Semantik netlestirilmeli. Beklenen davranis union ise `getAllAndMerge` veya explicit merge+dedupe kullanilmali. Override isteniyorsa bu belgelenmeli ve controller-level metadata kullanimi yasaklanmali.

Gerekli test: Class-level `product:read`, handler-level `product:update` fixture'i; sadece iki permission birlikte varsa `200`, tek tek varsa `403`.

TASK-010a etkisi: Class-level permission kalibi kullanilacaksa blocker; aksi halde route style guide ve scanner ile yasaklanmali.

### PG-004

Severity: **HIGH**

Sorun: Role icindeki permission degisimi icin guvenli invalidation kontrati eksik. Cache `securityVersion` yalniz principal role-name setinden uretiliyor; ayni role uzerindeki permission ekleme/cikarma cache key'i degistirmiyor. `invalidate(userId)` process-local in-memory cache'i temizliyor; multi-instance invalidation yok.

Kanıt:

- `securityVersion` role string setinden hash uretiyor: `apps/api/src/modules/authorization/permission.service.ts:29`.
- Cache hit DB'ye gitmeden permission setini donduruyor: `apps/api/src/modules/authorization/permission.service.ts:40`.
- In-memory adapter process-local oldugunu belirtiyor ve `Map` kullaniyor: `apps/api/src/modules/authorization/adapters/in-memory-permission-cache.ts:15`.
- `invalidate(userId)` sadece mevcut process map'ini prefix ile siliyor: `apps/api/src/modules/authorization/adapters/in-memory-permission-cache.ts:51`.
- Integration test permission ekleme sonrasi invalidation olmadan stale sonuc bekliyor; permission removal/overgrant testi yok: `apps/api/test/integration/authz-permission-guard.test.ts:203`.

Yetki aşımı senaryosu: Bir rolden `stock:adjust` kaldirilir. Role membership degismedigi icin kullanicinin cache key'i ayni kalir ve eski cached permission seti TTL boyunca protected route'a erisim verebilir. Birden fazla API instance varsa tek process `invalidate(userId)` diger instancelarin stale cache'ini temizlemez.

Önerilen düzeltme: TASK-010a mutation servis kontrati zorunlu olmali: role/user/company `permissionVersion` veya `authzVersion` transaction icinde artirilmali ve cache key'e dahil edilmeli. Role-permission mutation, user-role mutation ve user disable/delete ayni invalidation/event kontratini kullanmali. Multi-instance icin Redis/pubsub veya merkezi version read modeli kullanilmali.

Gerekli test: Permission removal sonrasi ayni role setiyle hemen `403`; iki app instance veya iki cache adapter ile invalidation yayilimi; role assignment removal sonrasi yeni key'in eski cache'i okumadigi integration testi.

TASK-010a etkisi: Mutation endpointleri yazilmadan once zorunlu kontrat. Aksi halde grant ceiling revoke/permission azaltma aninda guvenilir olmaz.

### PG-005

Severity: **MEDIUM**

Sorun: Cache kullanilamaz veya hata verirse PostgreSQL source-of-truth'a fail-safe fallback yok. `cache.get` veya `cache.set` throw ederse `PermissionService` hatayi yakalamiyor.

Kanıt:

- `getEffectivePermissions` once `cache.get` cagiriyor, catch yok: `apps/api/src/modules/authorization/permission.service.ts:40`.
- `cache.set` hatasi da catch edilmeden request'i dusurur: `apps/api/src/modules/authorization/permission.service.ts:46`.

Yetki aşımı senaryosu: Redis tabanli gelecek cache adapter'i gecici hata verdiginde protected route'lar DB'ye dusmek yerine 500 donebilir. Bu daha cok availability/DoS riskidir; dogrudan overgrant degil, ama "PostgreSQL source-of-truth ile fail-safe calisma" beklentisini karsilamaz.

Önerilen düzeltme: Cache get/set hatalarini yakalayip logla; get hatasinda DB'den oku, set hatasinda DB sonucuyla devam et. Cache asla authorization icin required dependency olmamali.

Gerekli test: Throwing fake cache ile permission sahibi kullanici `200`, permission sahibi olmayan kullanici `403`; `set` throw etse bile DB karari donmeli.

TASK-010a etkisi: Non-blocking ama Redis/distributed cache'e gecmeden once gerekli.

### PG-006

Severity: **MEDIUM**

Sorun: `@RequirePermissions` serbest `string` kabul ediyor ve metadata catalog/seed ile CI'da dogrulanmiyor. Yazim hatasi sessiz sekilde tum kullanicilara `403` uretir; production route coverage henuz bu degerleri taramiyor.

Kanıt:

- Decorator imzasi `(...permissions: string[])`: `apps/api/src/modules/authorization/decorators/require-permissions.decorator.ts:17`.
- Domain catalog `PERMISSION_CODES` uretiyor ama decorator tipi bundan turetilmiyor: `packages/domain/src/rbac.ts:514`.
- Unit scanner sadece test controller method metadata'sini okuyor: `apps/api/test/unit/permission-guard.test.ts:164`.

Yetki aşımı senaryosu: Bu genelde denial-of-access riskidir; ancak operatorlar route'un korundugunu sanarken typo nedeniyle kimse erisemez ve acil durumda bypass/temporary guard removal gibi riskli degisikliklere gidilebilir.

Önerilen düzeltme: `PermissionCode` literal union export edilmeli ve decorator `PermissionCode[]` kabul etmeli. CI scanner production metadata'daki her kodu `PERMISSION_CODES` ile karsilastirmali.

Gerekli test: Bilinmeyen permission kodu tasiyan fixture controller scanner'da fail etmeli; tum production metadata catalogda bulunmali.

TASK-010a etkisi: Controller sayisi artmadan once uygulanmali.

### PG-007

Severity: **HIGH**

Sorun: Route-permission coverage scanner production controllerlari taramiyor; sadece test-only `TestAuthzController` uzerinde calisan local helper var. Yeni production controller permission metadata'si unutulursa mevcut CI'nin bunu yakaladigina dair kanit yok.

Kanıt:

- Unit test `findRoutesMissingPermissionGuard(TestAuthzController)` cagiriyor: `apps/api/test/unit/permission-guard.test.ts:179`.
- Scanner helper tek controller parametresi aliyor ve sadece handler metadata'sine bakiyor: `apps/api/test/unit/permission-guard.test.ts:195`.
- Test-only controller/module production app'e import edilmiyor: `apps/api/test/support/test-authz.module.ts:7`.

Yetki aşımı senaryosu: Yeni production controller `@UseGuards(JwtAuthGuard)` ile authenticated-only kalir ama mutating route icin `@RequirePermissions` unutulur; CI yesil kalir ve permission sahibi olmayan authenticated kullanici route'a erisir.

Önerilen düzeltme: `AppModule` metadata'sini bootstrap eden production route scanner eklenmeli. Her route explicit `@Public`, `@AuthenticatedOnly`, veya `@RequirePermissions` siniflandirmasina sahip olmali; mutating route'larda permission metadata zorunlu olmali. Scanner hem guard varligini hem canonical permission kodlarini kontrol etmeli.

Gerekli test: Production-like fixture module'de missing permission metadata ve missing `PermissionGuard` iki ayri fail senaryosu; authenticated-only route explicit marker ile false positive uretmemeli.

TASK-010a etkisi: **Reject/blocking dependency.** Grant ceiling endpointleri eklenmeden CI coverage zorunlu.

## Requested Scenario Coverage

| Scenario | Status |
| --- | --- |
| Permission sahibi kullanici `200` | PASS, authz integration test 1 |
| Permission sahibi olmayan kullanici `403` | PASS, authz integration test 2 |
| Authentication yok `401` | PASS, authz integration test 3 |
| Forged JWT permission/role claim `403` | PASS, authz integration test 8 |
| Forged JWT warehouse scope claim | Mechanism should ignore extra claims, but no explicit warehouse-scope forged claim test exists |
| ADMIN adi fakat permission yok `403` | PASS, authz integration test 9 |
| SYSTEM_ADMIN role-name runtime bypass yok | PASS by code review; seeded permissions grant authority, guard has no role-name branch |
| VIEWER ozel dali yok | PASS by code review; VIEWER uses seeded permission matrix |
| Iki rolden permission birlesimi | PASS, authz integration test 5 |
| Birden fazla required permission all-of | PASS, authz integration test 4 and `required.every` |
| Disabled user | PASS, authz integration test 7 |
| Soft-deleted user | PASS in auth regression (`/auth/me`), not in authz test-only route |
| Cache cold load | PASS, authz integration test 11 |
| Cache invalidate sonrasi permission degisikligi | PASS for permission addition; removal/overgrant case missing |
| Role removed cache key changes | Unit coverage only; integration removal test missing |
| Rol ici permission degisimi stale TTL | CONFIRMED stale-by-design; removal risk untested |
| Cross-company role assignment negative test | MISSING and not representable with current schema |
| Controller + handler metadata birlesimi | FAIL; current code overrides |
| RFC7807 403 + requestId | PASS, authz integration tests 13 and 14 |
| Prisma/internal permission response leakage | PASS for current auth API; no role/permission API exists |

## Final Gate

**REJECTED_PERMISSION_GUARD**
