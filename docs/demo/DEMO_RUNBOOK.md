# Demo Runbook — B2B Operations Suite

End-to-end guide to standing up the suite locally and walking the full back-office
flow for a demo. This is an **operational** document; the single source of truth
for behaviour remains [PROJECT_SPEC.md](../../PROJECT_SPEC.md) and `docs/`.

> Scope note: the suite is a set of **foundation milestones**. Every module listed
> in [FINAL_PROJECT_STATUS.md](../reviews/FINAL_PROJECT_STATUS.md) is implemented
> and reviewed end-to-end (API + UI), but a few capabilities are intentionally
> out of scope for the demo — see [Known limitations](#9-known-limitations).

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
- **Some flows need the live stack to E2E.** Playwright smoke (login + every
  route + the seeded workflow) requires a real PostgreSQL-backed API + web. The
  unit/component suite (Vitest, 180 tests) runs without any stack. See §10.
- **No payments / notifications / email features** beyond password-reset
  delivery to the dev SMTP sink.
- **No implicit warehouse access.** Even SYSTEM_ADMIN needs `warehouse:scope:all`
  or an explicit scope row — by design (deny-by-default). If a warehouse screen
  is empty/403, check the user's scope first.
- **Redis is best-effort** for the login throttle; correctness (stock, lockout)
  is always PostgreSQL.

---

## 10. Smoke / E2E (optional, needs the live stack)

The web Playwright suite boots the **real** built API + web and seeds a
deterministic user (`apps/web/e2e/global-setup.ts`). It requires `DATABASE_URL`
pointing at a **test** database (name must contain `test`):

```bash
# build first so `node dist/main.js` (API) and `next start` (web) are runnable
pnpm build
DATABASE_URL=postgresql://b2b:b2b@localhost:5432/b2b_test \
  pnpm --filter @b2b/web test:e2e
```

Smoke coverage (`apps/web/e2e/`): auth (login / wrong-credentials / session
renewal / no-token-in-storage / logout / protected-route redirect),
`navigation.spec.ts` (every sidebar destination loads + Inventory tab + deep
logout + unauthenticated deep-route redirect), plus per-module page smokes
(products, warehouses, customers, returns, credit-notes, reports).

If you have no live stack, do **not** mark E2E as passed — run the manual flow in
§8 instead and the Vitest suite for component coverage:

```bash
pnpm --filter @b2b/web test     # 180 component/unit tests, no stack required
```
