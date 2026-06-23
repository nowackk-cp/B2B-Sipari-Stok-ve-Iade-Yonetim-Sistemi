# Demo Runbook — B2B Operations Suite

End-to-end guide to standing up the suite locally and walking the full back-office
flow for a demo. This is an **operational** document; the single source of truth
for behaviour remains [PROJECT_SPEC.md](../../PROJECT_SPEC.md) and `docs/`.

> Scope note: the suite is a set of **foundation milestones**. Every module listed
> in [FINAL_PROJECT_STATUS.md](../reviews/FINAL_PROJECT_STATUS.md) is implemented
> and reviewed end-to-end (API + UI), but a few capabilities are intentionally
> out of scope for the demo — see [Known limitations](#9-known-limitations).
>
> **Demo-ready ≠ release-ready.** This runbook gets you to a working demo against a
> local stack. Release approval additionally requires the **final backend gate**
> (DB + API integration on a real PostgreSQL) to run green in the approving
> environment — a live stack, not a recorded prior run. See
> [§10](#10-smoke--e2e-optional-needs-the-live-stack).

---

## 1. What you are starting

| Component  | What it is                                  | Default URL                         |
| ---------- | ------------------------------------------- | ----------------------------------- |
| Web        | Next.js App Router operations console       | http://localhost:3000               |
| API        | NestJS REST API (`/api/v1`, RFC 7807)       | http://localhost:3001/api/v1        |
| API health | Liveness probe                              | http://localhost:3001/api/v1/health |
| Swagger    | OpenAPI explorer (dev only)                 | http://localhost:3001/api/docs      |
| Worker     | BullMQ standalone worker (outbox/effects)   | —                                   |
| PostgreSQL | System of record (correctness lives here)   | localhost:5432                      |
| Redis      | Login throttle + queue transport (optional) | localhost:6379                      |
| Mailpit    | Dev SMTP sink (password-reset mail)         | http://localhost:8025               |
| MinIO      | S3-compatible object storage                | http://localhost:9001               |

### Required vs optional for a UI demo

- **Required:** PostgreSQL, API, Web.
- **Recommended:** Worker (background effects), Redis (login throttle — fails
  open if absent; the durable account lockout in PostgreSQL stays authoritative).
- **Only if you exercise that path:** Mailpit (password reset), MinIO (object
  storage). Neither is needed for the core order→invoice→return→credit-note flow.

---

## 2. Prerequisites

- Node.js >= 20.11 with Corepack (`corepack enable`)
- pnpm 9 (`corepack prepare pnpm@9.15.0 --activate`)
- Docker + Docker Compose (for the infra services), **or** a reachable
  PostgreSQL 16 and (optionally) Redis you provide yourself.

> Windows note: if `pnpm` is blocked by PowerShell execution policy, invoke
> `pnpm.cmd …` instead of `pnpm …`.

---

## 3. Environment variables

All configuration is `zod`-validated by `@b2b/config` and **fails fast at boot**
on a missing/invalid required value. The committed template
[`.env.example`](../../.env.example) holds development-safe defaults (no real
secrets) and documents every variable inline.

```bash
cp .env.example .env
```

Key variables to know for a demo:

| Variable                      | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection (API, worker, Prisma).       |
| `REDIS_URL`                   | Login throttle + queue. Throttle fails open.       |
| `JWT_ACCESS_SECRET`           | Access-token signing (>= 32 chars).                |
| `PASSWORD_RESET_DELIVERY_KEY` | AES-256-GCM key sealing reset tokens (>= 32 bytes).|
| `SMTP_HOST` / `SMTP_PORT`     | Dev → Mailpit (`localhost:1025`).                  |
| `NEXT_PUBLIC_API_BASE_URL`    | Browser → API base. Default `…:3001/api/v1`.       |
| `BOOTSTRAP_ADMIN_EMAIL`       | (Optional) seed a SYSTEM_ADMIN demo user — see §6. |
| `BOOTSTRAP_ADMIN_PASSWORD_HASH` | (Optional) pre-computed argon2id hash for above. |

`SHADOW_DATABASE_URL` is additionally required by the drift gate (`db:drift`), not
by the running app.

> Production: never commit real values. Inject via a secret manager, set
> `NODE_ENV=production`, put Swagger behind auth or disable it, and rotate
> `DATABASE_URL` / S3 / SMTP credentials. See the footer of `.env.example`.

---

## 4. Bring up infrastructure + migrate

```bash
# 1. Infra (PostgreSQL, Redis, MinIO + bucket, Mailpit)
docker compose up -d
node scripts/check-infra.mjs        # optional smoke-check of the services

# 2. Dependencies + workspace package build (apps consume compiled packages)
pnpm install
pnpm build

# 3. Apply committed migrations to the database
pnpm --filter @b2b/database db:migrate:deploy
```

`db:migrate:deploy` applies the **forward-only** migrations under
`packages/database/prisma/migrations/` (21 migrations as of this milestone),
including the hand-written SQL Prisma cannot model (extensions, CHECK
constraints, partial-unique indexes, append-only/`updated_at` triggers). It is
idempotent: re-running on an up-to-date database is a no-op.

---

## 5. Seed system data

```bash
pnpm --filter @b2b/database db:seed
```

The seed is **idempotent and production-safe** (one transaction). It ensures:

- the canonical permission catalog + the six system roles + the role→permission
  matrix,
- a default company, a default warehouse (`MAIN`), and the current fiscal-year
  invoice series (`INV-<year>-`).

It creates **no** business data (no demo products/orders) and grants **no**
implicit warehouse scope to any role. Run it as many times as you like.

---

## 6. Demo user

There is **no hard-coded password** anywhere. Pick one path:

**Option A — bootstrap SYSTEM_ADMIN via the seed (recommended for a clean DB).**
Set both vars, then seed. The hash must be a pre-computed argon2id encoding (the
seed never handles plaintext and never resets an existing user's password):

```bash
export BOOTSTRAP_ADMIN_EMAIL="admin@demo.local"
export BOOTSTRAP_ADMIN_PASSWORD_HASH="<argon2id-encoded-hash>"
# optional: export BOOTSTRAP_ADMIN_NAME="Demo Admin"
pnpm --filter @b2b/database db:seed
```

A SYSTEM_ADMIN still has **no warehouse scope by default**. For warehouse-scoped
screens (stock, orders against a warehouse) the admin must hold the protected
`warehouse:scope:all` permission (seeded onto SYSTEM_ADMIN) or an explicit
`user_warehouse_scopes` row. The seeded SYSTEM_ADMIN gets `warehouse:scope:all`
via the role matrix.

**Option B — deterministic E2E user (test database only).** The script refuses
any database whose name does not contain `test`:

```bash
E2E_USER_EMAIL=e2e@test.local E2E_USER_PASSWORD="e2e correct horse staple" \
  node apps/api/scripts/seed-e2e-user.mjs
```

---

## 7. Run the app

```bash
pnpm dev    # turbo: api + worker + web together
```

Then open http://localhost:3000 — you are bounced to `/login` until
authenticated. Sign in with the demo user from §6.

---

## 8. Demo flow (happy path) and expected results

> Permissions gate every action **server-side**; the UI only hides what the user
> cannot do. Use a SYSTEM_ADMIN (with `warehouse:scope:all`) to walk the whole
> flow without per-screen permission errors.

| # | Action                       | Where                | Expected result                                                                 |
| - | ---------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| 1 | **Login**                    | `/login`             | Redirect to `/dashboard`; email shown top-right; refresh keeps the session.     |
| 2 | **Dashboard**                | `/dashboard`         | Summary cards render (counts + today's sales, BigInt-safe money).               |
| 3 | **Create a product**         | `/products`          | New row in the products table; SKU/name persisted.                              |
| 3a| **CSV import / export**      | `/products`          | Import adds rows; export downloads a CSV (formula-injection-safe).              |
| 4 | **Create a warehouse**       | `/warehouses`        | New warehouse row; company-scoped code unique.                                  |
| 5 | **Create a customer**        | `/customers`         | New customer row; type/search filters work.                                     |
| 6 | **Create a draft order**     | `/orders`            | Order in `DRAFT`; line prices come from the server `list_price`, not the client.|
| 7 | **Approve the order**        | order drawer         | `DRAFT → APPROVED`; stock reserved all-or-nothing (insufficient stock = full reject, stays DRAFT). |
| 8 | **Ship the order**           | order drawer         | `APPROVED → SHIPPED`; reserved stock is committed (deducted from on-hand).       |
| 9 | **Issue an invoice**         | order drawer         | `SHIPPED` order → `ISSUED` invoice with a **gapless** `INV-<year>-N` number.     |
| 10| **View invoices**           | `/invoices`          | Invoice appears in the list; detail drawer shows totals (BigInt-safe).           |
| 11| **Create a return**         | `/returns`           | Return raised against the SHIPPED order in `REQUESTED` (a.k.a. DRAFT) status.    |
| 12| **Approve the return**      | return drawer        | `REQUESTED → APPROVED`; warehouse lifecycle revalidated under lock.              |
| 13| **Issue a credit note**     | return drawer        | APPROVED return → credit note `CRN-<year>-N`; requires the original invoice (else 422). |
| 14| **Credit notes**            | `/credit-notes`      | Credit note appears with status + amount.                                       |
| 15| **Reports**                 | `/reports`           | Sales / Inventory / Returns tabs each load; `?tab=inventory` deep-links work; Inventory sidebar entry selects the inventory tab. |

Money is always rendered from minor units via BigInt grouping (never JS
`number`), and API errors surface their RFC 7807 `detail`/`title` to the user
with a retry where applicable.

---

## 9. Known limitations

These are **intentional** for this milestone — call them out during the demo:

- **No PDF generation.** Invoices and credit notes are data records with numbers
  and totals; there is no rendered PDF/print artifact.
- **No live/cloud deployment.** The demo runs against the local stack; there is
  no hosted environment or deploy pipeline wired up.
- **Playwright smoke needs the live stack.** The browser smoke (login + every
  route + reports tabs) requires a real PostgreSQL-backed API + web; it is green
  (19/19) on that stack. The unit/component suite (Vitest, 180 tests) runs
  without any stack. The full create→…→credit-note workflow stays a manual demo
  (§8), not an automated gate. See §10.
- **No payments / notifications / email features** beyond password-reset
  delivery to the dev SMTP sink.
- **No implicit warehouse access.** Even SYSTEM_ADMIN needs `warehouse:scope:all`
  or an explicit scope row — by design (deny-by-default). If a warehouse screen
  is empty/403, check the user's scope first.
- **Redis is best-effort** for the login throttle; correctness (stock, lockout)
  is always PostgreSQL.

---

## 10. Smoke / E2E (optional, needs the live stack)

> **Final release gate (live stack required).** Release approval depends on the
> real-PostgreSQL backend gate — `pnpm --filter @b2b/api test:integration`,
> `pnpm --filter @b2b/database test:database-gate`, `db:migrate:deploy` (clean DB
> then a second idempotent run), `db:seed` ×2, `db:drift`, `db:verify-catalog`.
> These are **fail-closed**: with no reachable PostgreSQL they exit non-zero
> ("TESTS NOT EXECUTED"), never a false green. Run them against a real PostgreSQL
> 16 test database (+ a separate `SHADOW_DATABASE_URL` for `db:drift`). The API
> gate uses an in-memory rate limiter, so **Redis is not required** for it; the
> running app still expects `REDIS_URL` (login throttle fails open if Redis is
> down — PostgreSQL stays authoritative). **Provision Redis for production
> runtime** (login throttle + queue transport) — it is a deployment requirement,
> not a gate requirement.

### Web E2E (Playwright) — runnable on the live stack

The web Playwright suite boots the **real** built API + a freshly-built Next
server and seeds a deterministic user via `apps/web/e2e/global-setup.ts`
(→ `apps/api/scripts/seed-e2e-user.mjs`). The seed is self-contained and
idempotent: it runs the canonical system seed (default company + roles +
warehouse + invoice series) and then **pins the E2E user to that company** with a
SYSTEM_ADMIN role and an explicit warehouse scope, so every screen loads. It
refuses any database whose name does not contain `test`.

Required: `DATABASE_URL` pointing at a real **test** PostgreSQL (name must
contain `test`). Optional overrides: `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`,
`E2E_USER_NAME`, `E2E_WAREHOUSE_CODE`. `PASSWORD_RESET_DELIVERY_KEY` and
`JWT_ACCESS_SECRET` are defaulted to throwaway test values by the Playwright
config when unset. Redis is not required (rate limiter fails open).

```bash
# build the workspace packages first (the API runs node dist/main.js;
# the web webServer rebuilds itself with NEXT_PUBLIC_API_BASE_URL inlined)
pnpm build
# apply migrations to the test DB (schema), then run the suite (it seeds data)
DATABASE_URL=postgresql://b2b:b2b@localhost:5432/b2b_test \
  pnpm --filter @b2b/database db:migrate:deploy
DATABASE_URL=postgresql://b2b:b2b@localhost:5432/b2b_test \
  pnpm --filter @b2b/web test:e2e
```

> Why the web rebuilds: `NEXT_PUBLIC_*` values are inlined into the browser
> bundle at **build** time. The Playwright `webServer` therefore runs `next
> build && next start` with `NEXT_PUBLIC_API_BASE_URL` set, so the browser hits
> the E2E API. A plain `pnpm build` without that env would bake in an unconfigured
> URL and login would silently fail.

Smoke coverage (`apps/web/e2e/`, **19 specs, all green** on a real stack): auth
(login / wrong-credentials / session renewal / no-token-in-storage / logout /
protected-route redirect), `navigation.spec.ts` (every sidebar destination loads
+ Inventory tab + deep logout + unauthenticated deep-route redirect),
`reports.spec.ts` (sales / inventory / returns tabs each reach a terminal state),
plus per-module page + modal smokes (products, warehouses, customers, returns,
credit-notes). The full create→approve→ship→invoice→return→credit-note workflow
is **not** an automated gate (kept as the manual demo in §8 to avoid flakiness);
navigation + reports smoke are the mandatory automated gate.

If you have no live stack, do **not** mark E2E as passed — run the manual flow in
§8 instead and the Vitest suite for component coverage:

```bash
pnpm --filter @b2b/web test     # 180 component/unit tests, no stack required
```

### One-shot final gate

`scripts/final-gate.ps1` sequences every gate below in order and fails closed on
the first red (it only wraps the same `pnpm` scripts — no behaviour change):

```powershell
$env:DATABASE_URL        = 'postgresql://b2b:b2b@127.0.0.1:55432/b2b_gate_test?schema=public'
$env:SHADOW_DATABASE_URL = 'postgresql://b2b:b2b@127.0.0.1:55432/b2b_gate_shadow_test?schema=public'
pwsh scripts/final-gate.ps1            # backend + frontend + root + E2E
pwsh scripts/final-gate.ps1 -SkipE2e    # skip the browser smoke
pwsh scripts/final-gate.ps1 -SkipBackend # frontend + root only (no PostgreSQL)
```
