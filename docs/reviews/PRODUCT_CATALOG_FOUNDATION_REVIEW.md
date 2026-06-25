# Product Catalog Foundation Review

Date: 2026-06-16

Commit reviewed: `4115958bbcec92d064de2fb198b95a843efd5cf9`

Scope: review only of the Product Catalog Foundation commit. Production code was
not changed. This review inspected the requested source, migrations, contracts
and tests, ran the requested gates against real PostgreSQL, and added this
document.

Result: **REJECTED**

## Findings

### BLOCKER: Product numeric string validation permits DB bigint overflow and returns 500

`MoneyInputDto.amount` and `CreateProductDto.criticalStockThreshold` accept any
non-negative string up to 20 characters, but both are converted directly to
`BigInt` and written into PostgreSQL `BIGINT` columns. A 20-digit value above
`9223372036854775807` passes DTO validation, reaches Prisma, and returns
RFC7807 `500 INTERNAL` instead of a validation/business error.

Evidence:

- `apps/api/src/modules/products/dto/money.dto.ts:14`
- `apps/api/src/modules/products/dto/money.dto.ts:15`
- `apps/api/src/modules/products/dto/create-product.dto.ts:105`
- `apps/api/src/modules/products/dto/create-product.dto.ts:106`
- `apps/api/src/modules/products/products.service.ts:165`
- `apps/api/src/modules/products/products.service.ts:169`
- `apps/api/src/modules/products/products.service.ts:188`
- `apps/api/src/modules/products/products.service.ts:193`

Manual real-app probe after `pnpm.cmd build`:

- `POST /api/v1/products` with
  `listPrice.amount = "99999999999999999999"` returned `500 INTERNAL`.
- `POST /api/v1/products` with
  `criticalStockThreshold = "99999999999999999999"` returned `500 INTERNAL`.
- Both responses preserved RFC7807 shape and `requestId`, but the boundary
  validation failed to reject invalid input as 400/422.

### BLOCKER: Product OpenAPI response schemas are empty

The Product controller decorates tags, bearer auth and operation summaries, and
request DTO schemas are emitted. Product responses are TypeScript interfaces
(`ProductView`, `ProductListView`) with no explicit `@ApiOkResponse`,
`@ApiCreatedResponse` or schema decorators, so generated OpenAPI has empty
response content for all Product endpoints.

Generated OpenAPI evidence:

- `POST /api/v1/products` has response `201` with no content schema.
- `GET /api/v1/products` has response `200` with no content schema.
- `GET /api/v1/products/{id}` has response `200` with no content schema.
- `PATCH /api/v1/products/{id}` has response `200` with no content schema.
- `DELETE /api/v1/products/{id}` has response `204` with no content schema
  which is acceptable for delete.
- Product-related emitted schemas are only `CreateProductDto`, `MoneyInputDto`
  and `UpdateProductDto`.

Evidence:

- `apps/api/src/modules/products/products.controller.ts:16`
- `apps/api/src/modules/products/products.controller.ts:45`
- `apps/api/src/modules/products/products.controller.ts:50`
- `apps/api/src/modules/products/products.controller.ts:56`
- `apps/api/src/modules/products/products.controller.ts:60`
- `apps/api/src/modules/products/products.controller.ts:66`
- `apps/api/src/modules/products/products.controller.ts:67`
- `apps/api/src/modules/products/products.controller.ts:73`
- `apps/api/src/modules/products/products.controller.ts:79`

## Validation Matrix

| # | Validation | Result |
| --- | --- | --- |
| 1 | Product is company-scoped | PASS: `products.company_id` is NOT NULL, FK RESTRICT, and repository/service always pass actor company. |
| 2 | `companyId` is not read from request body | PASS: not in DTO/write data; create uses `actor.companyId`. |
| 3 | Body `companyId` is rejected | PASS: product integration test returns 400 for create body `companyId`; global `forbidNonWhitelisted` is active. |
| 4 | Actor company comes from PostgreSQL principal | PASS: `JwtAuthGuard` sets `principal.companyId = user.companyId`. |
| 5 | Forged JWT `companyId` does not change result | PASS: product and authz cache integration tests cover forged company claims. |
| 6 | SKU unique within same company active products | PASS: API and DB tests cover same-company duplicate reject. |
| 7 | Different companies can use same SKU | PASS: API and DB tests cover same SKU across companies. |
| 8 | SKU reusable after soft delete | PASS: API and DB tests cover reuse after `deleted_at`. |
| 9 | Soft-deleted product hidden from list/get | PASS: product integration test covers list/get 404/hidden. |
| 10 | Cross-company get/update/delete hide existence | PASS: forged/cross-tenant get/update/delete return 404 and leave row unchanged. |
| 11 | Create/update/delete audit uses same transaction | PASS by code: each mutation writes audit via the same `tx`; create audit covered by product test. |
| 12 | PermissionGuard global chain used | PASS: `AppModule` binds `JwtAuthGuard` then `PermissionGuard`; Product controller has no local `@UseGuards`. |
| 13 | Route permission matrix is correct | PASS: routes map to `product:read/create/update/delete` per `docs/PERMISSION_MATRIX.md`. |
| 14 | Role-name branch | PASS: no Product authz branch on role name found; tests cover no role-name shortcut. |
| 15 | Pagination/search/filter | PASS: limit capped, cursor validated, Prisma filters remain company-scoped and soft-delete scoped. |
| 16 | RFC7807 + requestId | PASS: product not-found and manual overflow probe preserve problem+json/requestId. |
| 17 | Swagger/OpenAPI metadata | FAIL: request schemas exist, but Product response schemas are empty. |
| 18 | Product does not store stock quantity | PASS: no on-hand/reserved/available quantity on Product; `criticalStockThreshold` is documented as alert threshold. |
| 19 | Tenant isolation, warehouse scope, grant ceiling, authz cache regression | PASS: focused and full API/DB gates passed with 0 skipped. |
| 20 | Drift/verify-catalog covers Product partial unique and company FK | PASS: drift allowlist includes `(company_id, sku)` residue; verify-catalog checks Product partial unique, FK and NOT NULL column. |

## Code Review Evidence

- Product migration adds `company_id`, fail-closed legacy backfill, NOT NULL,
  RESTRICT FK, and company-scoped partial unique `products_sku_key`:
  `packages/database/prisma/migrations/20260616050000_product_catalog_company_scope/migration.sql:29`,
  `packages/database/prisma/migrations/20260616050000_product_catalog_company_scope/migration.sql:53`,
  `packages/database/prisma/migrations/20260616050000_product_catalog_company_scope/migration.sql:64`,
  `packages/database/prisma/migrations/20260616050000_product_catalog_company_scope/migration.sql:68`,
  `packages/database/prisma/migrations/20260616050000_product_catalog_company_scope/migration.sql:77`.
- The old global unique name `products_sku_key` is reused deliberately after
  dropping the previous index. Clean deploy and second deploy both passed.
- Prisma `Product` carries `companyId`, RESTRICT relation, `criticalStockThreshold`
  and the Prisma-side unique metadata for `(companyId, sku)`:
  `packages/database/prisma/schema.prisma:571`,
  `packages/database/prisma/schema.prisma:577`,
  `packages/database/prisma/schema.prisma:591`,
  `packages/database/prisma/schema.prisma:597`,
  `packages/database/prisma/schema.prisma:613`.
- Product reads and mutations are scoped by `actor.companyId`:
  `apps/api/src/modules/products/products.service.ts:56`,
  `apps/api/src/modules/products/products.service.ts:77`,
  `apps/api/src/modules/products/products.service.ts:92`,
  `apps/api/src/modules/products/products.service.ts:102`,
  `apps/api/src/modules/products/products.service.ts:130`.
- Repository list/get filters include `companyId` and `deletedAt: null`:
  `apps/api/src/modules/products/product.repository.ts:116`,
  `apps/api/src/modules/products/product.repository.ts:127`.
- Product create/update/delete business audit actions are defined and written
  with the same transaction handle:
  `apps/api/src/common/audit/audit-actions.ts:20`,
  `apps/api/src/modules/products/products.service.ts:55`,
  `apps/api/src/modules/products/products.service.ts:57`,
  `apps/api/src/modules/products/products.service.ts:109`,
  `apps/api/src/modules/products/products.service.ts:111`,
  `apps/api/src/modules/products/products.service.ts:132`,
  `apps/api/src/modules/products/products.service.ts:134`.
- Product integration tests cover fake JWT company, body `companyId`, duplicate
  SKU, cross-company SKU reuse, soft-delete hiding/reuse, cross-tenant update and
  delete, RFC7807 requestId and create audit:
  `apps/api/test/integration/products.test.ts:116`,
  `apps/api/test/integration/products.test.ts:140`,
  `apps/api/test/integration/products.test.ts:165`,
  `apps/api/test/integration/products.test.ts:179`,
  `apps/api/test/integration/products.test.ts:191`,
  `apps/api/test/integration/products.test.ts:216`,
  `apps/api/test/integration/products.test.ts:236`,
  `apps/api/test/integration/products.test.ts:262`,
  `apps/api/test/integration/products.test.ts:320`,
  `apps/api/test/integration/products.test.ts:361`.
- Drift and catalog verification include Product partial unique and company FK:
  `packages/database/scripts/drift-eval.mjs:13`,
  `packages/database/scripts/verify-catalog.mjs:106`,
  `packages/database/scripts/verify-catalog.mjs:169`,
  `packages/database/scripts/verify-catalog.mjs:194`.

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_product_catalog_review_test_20260616?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_product_catalog_review_shadow_20260616?schema=public`

| Command | Result |
| --- | --- |
| Clean DB `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 13 migrations applied |
| Second `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| PermissionGuard unit tests | PASS, 22/22 |
| Product integration tests | PASS, 17/17 real PostgreSQL tests |
| API tenant/grant/warehouse/cache/permission focused tests | PASS, 61/61 real PostgreSQL tests |
| DB tenant/warehouse/cache/RBAC/soft-delete focused tests | PASS, 60/60 real PostgreSQL tests |
| `pnpm.cmd test:database-gate` | PASS, 125/125 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd test:integration:api` | PASS, 175/175 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| Product numeric overflow manual API probe | FAIL, invalid 20-digit values returned 500 |
| Product OpenAPI metadata generation + inspection | FAIL, Product response schemas empty |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |

## Final Gate

**REJECTED**
