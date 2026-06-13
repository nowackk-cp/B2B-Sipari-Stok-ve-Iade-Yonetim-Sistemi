# @b2b/database

Prisma data-access package for the B2B Operations Suite.

> **Foundation status (Milestone 1A):** this package is a working skeleton.
> The Prisma schema declares only the datasource and generator — there are **no
> domain models yet**. The full schema, CHECK constraints, append-only triggers
> and partial-unique indexes are implemented in **TASK-004** and later tasks,
> following [DATABASE_DESIGN.md](../../docs/architecture/DATABASE_DESIGN.md).

## Layout

```
packages/database
├── prisma/
│   └── schema.prisma     # datasource + generator only (no models yet)
├── src/
│   ├── index.ts          # package metadata + seed export
│   └── seed.ts           # runnable, idempotent seed (currently a no-op)
└── package.json          # lifecycle scripts
```

## Lifecycle scripts

| Script                   | Command                 | Purpose                                                |
| ------------------------ | ----------------------- | ------------------------------------------------------ |
| `db:generate`            | `prisma generate`       | Generate the typed Prisma client (after models exist). |
| `db:migrate` / `migrate` | `prisma migrate dev`    | Create + apply a development migration.                |
| `db:migrate:deploy`      | `prisma migrate deploy` | Apply committed migrations (CI / prod).                |
| `db:seed`                | `tsx src/seed.ts`       | Run the idempotent seed.                               |
| `db:studio`              | `prisma studio`         | Inspect data locally.                                  |

Run from the repo root, e.g. `pnpm --filter @b2b/database db:migrate`.

`DATABASE_URL` is read from the environment (see the root `.env.example`).

## Database lifecycle (target, from TASK-004 onwards)

1. **Author schema** in `prisma/schema.prisma` (enums + tables per design doc).
2. **Add raw SQL** for CHECK constraints, append-only triggers and
   partial-unique indexes inside the generated migration (Prisma cannot express
   these). Append-only tables (`stock_ledger`, `audit_logs`, ...) get
   UPDATE/DELETE-blocking triggers.
3. **`prisma migrate dev`** to create the migration; commit it.
4. **`prisma generate`** to produce the typed client (exported from
   `src/client.ts`, a single shared instance).
5. **Seed** protected roles/permissions, system admin and the default invoice
   series — each idempotent.
6. **CI** runs `prisma migrate deploy` against a real Postgres service and a
   `prisma migrate diff` drift check (must be zero).

> Migrations are **forward-only** and reviewed: never edit a committed
> migration; add a new one. Append-only / immutable tables are never dropped or
> altered destructively.
