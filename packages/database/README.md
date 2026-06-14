# @b2b/database

Prisma data-access package for the B2B Operations Suite. Owns the database
schema, migrations, the shared client lifecycle, the transaction helper and the
idempotent system seed. **Server-only** — the ESLint and `check:boundaries`
rules forbid importing this package (or Prisma) from the frontend,
`@b2b/contracts` or `@b2b/domain`.

> Authority: [DATABASE_DESIGN.md](../../docs/architecture/DATABASE_DESIGN.md).

## Layout

```
packages/database
├── prisma/
│   ├── schema.prisma          # full domain schema (48 models, 17 enums)
│   ├── migrations/            # committed, forward-only SQL migrations
│   │   ├── migration_lock.toml
│   │   └── 20260614000000_init/migration.sql
│   └── seed.ts                # `prisma db seed` entry (delegates to src/seed)
├── scripts/
│   └── check-drift.mjs        # schema ⇄ migration drift gate
├── src/
│   ├── index.ts               # package entry (client, tx, seed, env)
│   ├── client.ts              # single, lazy PrismaClient lifecycle
│   ├── transaction.ts         # typed, callback-based transaction helper
│   ├── env.ts                 # fail-fast DATABASE_URL validation
│   ├── seed.ts                # central idempotent seed implementation
│   └── testing/index.ts       # integration-test utilities (prod-DB guard)
└── test/integration/          # real-PostgreSQL integration tests
```

## Conventions (DATABASE_DESIGN)

- **Identity:** `BIGINT` identity PKs (sequential, index-friendly). Externally
  addressable aggregates also carry a `public_id UUID` (`gen_random_uuid()`) to
  avoid leaking sequential ids over the public API.
- **Time:** every timestamp is `timestamptz`; values are stored in **UTC**.
- **Money:** `BIGINT` minor unit + `CHAR(3)` ISO currency; tax/discount in basis
  points. Never a JS `number`.
- **Soft delete:** `deleted_at` only on the master-data tables allowed by §16;
  their business-key uniques are **partial** (`WHERE deleted_at IS NULL`).
- **Immutable / append-only:** `stock_ledger`, `audit_logs`, `payments`,
  `order_price_overrides` and the status-history tables block UPDATE/DELETE via
  database triggers (defense in depth).

## What Prisma cannot express (migration-only SQL)

The migration appends hand-written SQL for objects Prisma cannot model. These
are applied at **migrate-deploy time only** (never at app runtime):

- Extensions: `pgcrypto`, `citext`, `pg_trgm`.
- CHECK constraints (stock invariants, money/rate ranges, currency format,
  distinct transfer warehouses, positive quantities, positive `next_number`).
- Partial unique indexes for soft-deletable business keys.
- `updated_at` maintenance triggers and append-only immutability triggers
  (`prevent_mutation()` raising a stable, testable `append_only_violation`).

## Lifecycle scripts

| Script              | Command                                            | Purpose                                 |
| ------------------- | -------------------------------------------------- | --------------------------------------- |
| `db:format`         | `prisma format`                                    | Format the schema.                      |
| `db:validate`       | `prisma validate`                                  | Validate the schema.                    |
| `db:generate`       | `prisma generate`                                  | Generate the typed client.              |
| `db:migrate`        | `prisma migrate dev`                               | Create + apply a dev migration.         |
| `db:migrate:deploy` | `prisma migrate deploy`                            | Apply committed migrations (CI / prod). |
| `db:seed`           | `tsx prisma/seed.ts`                               | Run the idempotent seed.                |
| `db:drift`          | `node scripts/check-drift.mjs`                     | Schema ⇄ migration drift gate.          |
| `test:integration`  | `vitest run --config vitest.integration.config.ts` | Real-PostgreSQL tests.                  |

`DATABASE_URL` is read from the environment and validated fail-fast (see the
root `.env.example`). The drift gate additionally needs `SHADOW_DATABASE_URL`.

## Seed

The seed is **idempotent and production-safe**, runs inside one transaction, and
is the single central source for system data:

- The canonical permission catalog (with `is_protected` flags + groups), the six
  system roles and the role→permission matrix — all sourced from `@b2b/domain`.
- A default company, default warehouse and the current fiscal-year invoice
  series.
- **No role receives implicit warehouse scope**; the protected
  `warehouse:scope:all` permission is granted to `SYSTEM_ADMIN` only.
- A bootstrap `SYSTEM_ADMIN` user is created **only** when both
  `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD_HASH` (a pre-computed
  argon2id hash) are set. The seed never handles plaintext, never logs the
  secret, and never resets an existing user's password.

## Integration tests

Tests run against **real PostgreSQL** (never SQLite/mocks). They refuse to run
against a non-test database (the database name must contain `test`, and
`NODE_ENV=production` is rejected), run serially, and TRUNCATE between cases. If
no test database is configured they self-skip — the database gate is only truly
green once these run against Postgres in CI.

> Migrations are **forward-only** and reviewed: never edit a committed
> migration; add a new one.
