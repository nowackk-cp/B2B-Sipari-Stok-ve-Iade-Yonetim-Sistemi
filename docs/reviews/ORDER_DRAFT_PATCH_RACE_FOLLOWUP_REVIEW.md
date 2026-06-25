# Order Draft PATCH Race Follow-up Review

Commit: `5562326090b625e172eaf2347f50dd4c945055d3`

Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Verdict

The blocking PATCH race from `ORDER_DRAFT_FOUNDATION_REVIEW.md` is fixed.

## Verified

- `OrderRepository.updateOrder` now uses a database-level expected-status guard with `updateMany({ id, status: 'DRAFT' })`.
- Repository no longer performs an unconditional scalar update with `where: { id }` before replacing items.
- If the guarded update affects 0 rows, item delete/insert is not executed.
- `OrdersService.update` converts a null update result into `409 Conflict` inside the transaction.
- `ORDER_UPDATED` business audit is written only after a successful guarded update.
- Failed post-cancel PATCH does not write `ORDER_UPDATED`.
- Item replacement remains inside the same transaction as the guarded order update.
- Concurrent cancel-vs-PATCH no longer allows a cancel-winning request to leave a `CANCELLED` order with patched content.
- Cancel behavior remains expected-status guarded and unchanged.
- DRAFT PATCH and CANCELLED PATCH behavior remain covered.
- Cross-company, warehouse scope, permission behavior, pricing, totals, create, cancel, stock/reservation, and invoice scope were not changed by this commit.

## Non-blocking Notes

- The concurrent race test uses real HTTP and PostgreSQL, but it does not force both interleavings. It accepts either PATCH-win or cancel-win outcomes and can pass without deterministically exercising the `updateMany` 0-affected branch under a true concurrent loser path. Code inspection and the sequential post-cancel PATCH test cover the safety property; a stronger test could orchestrate the cancel-wins branch explicitly.

## Test Evidence

- `pnpm.cmd --filter @b2b/database db:migrate:deploy` on a clean database: passed.
- `pnpm.cmd --filter @b2b/database db:migrate:deploy` second run: passed.
- `pnpm.cmd --filter @b2b/database db:seed` twice: passed.
- `pnpm.cmd --filter @b2b/database db:validate`: passed.
- `pnpm.cmd --filter @b2b/database db:generate`: passed.
- `pnpm.cmd --filter @b2b/database db:drift`: passed.
- `pnpm.cmd --filter @b2b/database db:verify-catalog`: passed.
- Focused order OpenAPI and product/customer/warehouse/stock/transfer integration regression suite: passed, 155 tests.
- `pnpm.cmd test:integration:api`: passed, 344/344 real PostgreSQL tests executed, 0 skipped.
- `pnpm.cmd test:database-gate`: passed, 133/133 real PostgreSQL tests executed, 0 skipped.
- `pnpm.cmd typecheck`: passed.
- `pnpm.cmd lint`: passed.
- `pnpm.cmd build`: passed.
- `pnpm.cmd check:no-skip`: passed.
- `pnpm.cmd check:boundaries`: passed.
