# Product Catalog Foundation Follow-up Review

Date: 2026-06-16

Commit reviewed: `34b34e6763196ce6826d64512749c5533e5778a1`

Scope: review only of the Product Catalog blocker-fix commit. Production code
was not changed. This review re-checked the two previous blockers, the requested
Product source/test files, generated OpenAPI metadata, and the requested
regression gates against real PostgreSQL.

Result: **APPROVED**

## Findings

No blocking findings.

## Blocker Closure

### 1. Numeric validation

Status: PASS.

`MoneyInputDto.amount` and `CreateProductDto.criticalStockThreshold` now use
the shared `IsBigIntString` validator, which accepts only non-empty decimal
digit strings in PostgreSQL signed BIGINT range:
`0..9223372036854775807`.

Evidence:

- `apps/api/src/common/validation/is-bigint-string.decorator.ts`
- `apps/api/src/modules/products/dto/money.dto.ts`
- `apps/api/src/modules/products/dto/create-product.dto.ts`
- `apps/api/src/modules/products/dto/update-product.dto.ts`
- `apps/api/test/integration/products.test.ts`

Validation checks:

| Check | Result |
| --- | --- |
| `listPrice.amount` above PostgreSQL BIGINT max | PASS: real API test returns 400 RFC7807, not 500. |
| `criticalStockThreshold` above PostgreSQL BIGINT max | PASS: real API test returns 400 RFC7807, not 500. |
| `9223372036854775807` accepted | PASS: real API test creates product with max amount and threshold. |
| `9223372036854775808` and above rejected | PASS: validator boundary check rejects exact max+1 and higher values; real API over-range path returns 400 before Prisma. |
| Negative values rejected | PASS: real API test returns 400. |
| Decimal values rejected | PASS: real API test returns 400. |
| Empty string rejected | PASS: real API test returns 400. |
| Validation errors never produce 500 | PASS: product integration tests assert invalid numeric inputs return 400 problem+json. |
| RFC7807 and `requestId` preserved | PASS: product integration tests assert `application/problem+json`, `VALIDATION_ERROR`, and non-empty `requestId`. |
| Update DTO inherits validation | PASS: `UpdateProductDto` is `PartialType(CreateProductDto)` and real API update over-range test returns 400. |

Direct boundary check against the built validator:

| Value | Result |
| --- | --- |
| `9223372036854775807` | accepted |
| `9223372036854775808` | rejected |
| `99999999999999999999` | rejected |
| `-1` | rejected |
| `12.5` | rejected |
| empty string | rejected |

### 2. OpenAPI response schema

Status: PASS.

The Product controller now declares explicit response DTOs with
`@ApiCreatedResponse`, `@ApiOkResponse`, and `@ApiNoContentResponse`. The
response DTO classes expose runtime Swagger metadata while implementing the
contract interfaces.

Evidence:

- `apps/api/src/modules/products/dto/product-response.dto.ts`
- `apps/api/src/modules/products/products.controller.ts`
- `apps/api/test/integration/products-openapi.test.ts`
- generated `apps/api/openapi.json` inspection

Generated OpenAPI checks:

| Check | Result |
| --- | --- |
| `POST /api/v1/products` 201 schema | PASS: `$ref` to `#/components/schemas/ProductResponse`. |
| `GET /api/v1/products` 200 schema | PASS: `$ref` to `#/components/schemas/ProductListResponse`. |
| `GET /api/v1/products/:id` 200 schema | PASS: `$ref` to `#/components/schemas/ProductResponse`. |
| `PATCH /api/v1/products/:id` 200 schema | PASS: `$ref` to `#/components/schemas/ProductResponse`. |
| `DELETE /api/v1/products/:id` 204 schema | PASS: response is documented as no-content. |
| `ProductResponse` fields visible | PASS: id, sku, name, description, barcode, unit, categoryId, vatRate, listPrice, isActive, criticalStockThreshold, createdAt, updatedAt. |
| `MoneyResponse` fields visible | PASS: amount and currency. |
| `ProductListResponse` fields visible | PASS: data and pageInfo. |
| Runtime response shape unchanged | PASS: controller/service still return contract-shaped views; response DTOs are metadata only. |
| Contracts/DTO compatibility | PASS: response DTOs implement contract interfaces and typecheck passed. |

## Regression Review

| Area | Result |
| --- | --- |
| Tenant isolation | PASS: Product service/repository remain scoped by `actor.companyId`; real tenant isolation/API gates passed. |
| Body `companyId` | PASS: not present in DTOs; global whitelist rejection remains covered by product integration tests. |
| Forged JWT `companyId` | PASS: product integration test still proves the forged claim does not alter tenant scope. |
| SKU uniqueness | PASS: same-company active duplicate rejects; different companies can reuse SKU. |
| Soft-delete SKU reuse | PASS: soft-deleted Product is hidden from list/get and SKU is reusable. |
| Cross-company get/update/delete | PASS: still returns 404 and hides existence. |
| Audit transaction behavior | PASS: create/update/delete still write audit through the same Prisma transaction handle. |
| PermissionGuard route matrix | PASS: Product controller still has no local guard and routes map to product read/create/update/delete permissions. |
| Role-name authorization branch | PASS: no Product authorization branch trusts role names. |
| Product stock quantity | PASS: Product still stores only `criticalStockThreshold`; no stock quantity is stored on Product. |
| Money/vatRate edge cases | PASS: money amount is BIGINT-range validated; vatRate validation unchanged and typecheck/tests pass. |
| Partial unique drift allowlist | PASS: drift gate reports 5 allowlisted partial-unique statements and 0 unexpected drift. |
| Product catalog verification | PASS: verify-catalog passed with Product company FK and partial unique coverage. |

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_product_catalog_followup_review_test_20260616?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_product_catalog_followup_review_shadow_20260616?schema=public`

| Command | Result |
| --- | --- |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` on clean DB | PASS, 13 migrations applied |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` second run | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| Product integration tests | PASS, 22/22 real PostgreSQL tests |
| Product OpenAPI tests | PASS, 7/7 tests |
| PermissionGuard unit tests | PASS, 22/22 tests |
| Tenant isolation, grant ceiling, warehouse scope, authz cache, PermissionGuard integration tests | PASS, 61/61 real PostgreSQL tests |
| `pnpm.cmd test:integration:api` | PASS, 187/187 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd test:database-gate` | PASS, 125/125 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd --filter @b2b/api openapi:json` with dummy production env | PASS, generated product schemas verified |
| Direct built validator boundary check | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |

## Final Gate

**APPROVED**
