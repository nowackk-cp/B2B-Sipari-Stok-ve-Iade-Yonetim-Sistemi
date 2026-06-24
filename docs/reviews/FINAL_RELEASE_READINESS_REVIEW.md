# Final Release Readiness Review

Reviewed commit (before fix): `b4cfdf0`
Branch: `feat/web-app-shell-auth-dashboard`
Scope: Final API Gate Blocker Fix (FNB-001 follow-up).
Result: `FINAL_BLOCKER_FIXED`

## Previous reject reason

The prior review (`b4cfdf0`) returned `FINAL_REJECTED` because the full API
integration gate was red on real PostgreSQL: 575/576 passed, 1 failed. The
failure was `apps/api/test/integration/credit-notes.test.ts`:
`17. concurrent credit notes of DIFFERENT returns produce gapless, unique
numbers`, error `read ECONNRESET`. A targeted rerun reproduced the same
`read ECONNRESET`, so it was not just a long-suite timeout artifact.

## Root cause

The failure is a **test-harness flake, not a production bug** — the API server
never crashes. With temporary `process.on('uncaughtException')` /
`process.on('unhandledRejection')` probes installed, the failing run produced
**no uncaught exception, no unhandled rejection, and no Nest/Prisma error log**.
The server stays alive; only the supertest client socket is reset.

The reset comes from **supertest's lazy server bind**. supertest's `Test`
constructor (`supertest@7.0.0/lib/test.js`, `serverAddress`) does:

```js
const addr = app.address();
if (!addr) this._server = app.listen(0);
const port = app.address().port;
```

The integration harness (`createTestApp`) calls `await app.init()` but never
binds the HTTP server, so it is unbound until the first request touches it.
Test 17's first server interaction is `Promise.all([creditableReturn ×4])`,
which fires its first HTTP requests concurrently. When test 17 is the first
test to touch the server (e.g. a targeted `-t` run, or whichever ordering the
full gate happened to hit), all four concurrent requests see `app.address()`
== null and each calls `app.listen(0)` on the *same* server. The concurrent
double-bind resets the losing socket → `read ECONNRESET`.

This is why the bug is order-dependent and flaky:
- Full `credit-notes.test.ts` run: test 1 runs sequentially first and binds the
  server, so test 17 never races → passes.
- Targeted `-t "17"` run: test 17 is first; its 4 concurrent requests race the
  bind → intermittent `read ECONNRESET` (reproduced 1/3, then again after a
  controlled set of runs).

Confirmed reproduction (before fix): targeted run RUN 1 = `read ECONNRESET`,
RUN 2/3 = pass. An isolated single-test repro whose first request was an
*awaited* (sequential) login always passed — pinning the cause to the
concurrent-first-touch bind, not the credit-note business path.

## Fix

### Fix type

- **Test harness fix.** No production code, no DB schema/migration, no
  RBAC/auth/stock/order/invoice/return change, no credit-note
  gapless/idempotency change.

### Files changed

- `apps/api/test/integration/helpers.ts` — in `createTestApp`, after
  `app.init()`, bind the HTTP server once to an ephemeral port
  (`httpServer.listen(0)`), awaiting the `listening` callback (and rejecting on
  `error`). Because `server.address()` is then always set, supertest never
  lazy-binds and the concurrent double-`listen(0)` race cannot occur. The server
  is still the real Nest HTTP app over real PostgreSQL; `closeTestApp` →
  `app.close()` closes it.

No other files are modified. Temporary diagnostic probes
(`setup-integration.ts` listeners) and a scratch diagnostic test were added
during investigation and fully removed; `git diff` shows a single changed file.

### Behaviour preserved

- Credit-note gapless numbering and idempotency contracts unchanged — test 17
  still asserts `[1, 2, 3, 4]`, tests 5/6/7/18/19/19b still assert the
  same-return 409, same-key replay, gapless-after-rollback, and
  exactly-one-winner semantics, all green.
- No test skipped, no `.only`, no conditional skip, no loosened assertion, no
  raised timeout. Tests still run against real PostgreSQL and the real
  HTTP/Nest app.

## Evidence (real PostgreSQL, `127.0.0.1:55432`)

| Check | Result |
| --- | --- |
| Targeted test 17 (×5 after fix) | PASS 5/5, 0 `ECONNRESET` (was flaky before) |
| `credit-notes.test.ts` full file | PASS 26/26 |
| Full API gate `pnpm --filter @b2b/api test:integration` | PASS **576/576**, 0 skipped (exit 0) |
| DB gate `test:database-gate` | PASS **133/133**, 0 skipped |
| migrate deploy (clean DB, #1) | PASS, all migrations applied |
| migrate deploy (#2, idempotent) | PASS, "No pending migrations to apply" |
| seed ×2 | PASS, idempotent (69 perms / 229 rolePermissions / 6 roles / 1 company) |
| drift (`db:drift`) | PASS, 7 allowlisted partial-unique, 0 unexpected |
| verify catalog (`db:verify-catalog`) | PASS, all triggers/partial-uniques/CHECKs/FKs present |
| prisma validate / generate | PASS (schema valid; client generated) |
| root typecheck | PASS, 18/18 Turbo tasks |
| root build | PASS, 10/10 Turbo tasks |
| root lint | PASS (eslint, 0 errors) |
| format:check | PASS, all files Prettier-clean |
| check:docs | PASS, all relative links resolve |
| check:no-skip | PASS, no focused/skipped tests |
| check:boundaries | PASS, package boundaries respected |
| check:secrets | PASS, no secrets in tracked files |

Web tests were **not** rerun: no web/shared file changed (only the API
integration harness). The last recorded green web state stands —
`@b2b/web test` 180/180 and Playwright E2E 19/19 (real stack) per
`FINAL_PROJECT_STATUS.md` / commit `b4cfdf0`.

## Answers

- Skipped tests: **none** (API 576/576, DB 133/133, both 0 skipped).
- Credit-note gapless/idempotency behaviour changed: **no**.
- Business logic changed: **no** (test-harness only).
- Production code changed: **no**.

## Conclusion

The previous blocker (FNB-001, red API gate from `read ECONNRESET` in
credit-notes test 17) was a supertest lazy-bind race in the integration harness,
not a production defect. Binding the test HTTP server once up front makes the
concurrency suite deterministic. The full API gate is now green on real
PostgreSQL (576/576, 0 skipped), alongside DB 133/133 and all root gates.

`FINAL_BLOCKER_FIXED`

> FNB-002 (the `final-gate.ps1` "ALL GATES PASSED" message after `-SkipE2e` /
> `-SkipBackend`) was a HIGH, not the release BLOCKER, and is out of scope for
> this targeted gate-blocker fix; it remains open for a follow-up.
