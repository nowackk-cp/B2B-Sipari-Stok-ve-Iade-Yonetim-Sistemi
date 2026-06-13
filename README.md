# B2B Operations Suite

Modular-monolith back-office for product, warehouse, stock, order, return and
invoice operations. The single source of truth is
[PROJECT_SPEC.md](PROJECT_SPEC.md) and the documents under [`docs/`](docs/);
operational rules for contributors are in [CLAUDE.md](CLAUDE.md) and
[AGENTS.md](AGENTS.md).

> **Status:** Foundation Milestone 1A. Monorepo, configuration, logging,
> database skeleton, local infrastructure, CI, and the API/worker/web
> foundations are in place. Authentication, RBAC and business modules arrive in
> later milestones per [docs/tasks/IMPLEMENTATION_PLAN.md](docs/tasks/IMPLEMENTATION_PLAN.md).

## Workspace layout

```
apps/
  web/            Next.js App Router (foundation shell)
  api/            NestJS REST API (/api/v1, Swagger, RFC 7807)
  worker/         NestJS standalone + BullMQ (queue infra)
packages/
  config/         zod-validated environment (fail-fast)
  logger/         Pino logger + request-context + redaction
  database/       Prisma package skeleton (schema lands in TASK-004)
  shared/         framework-agnostic types/constants (HTTP, health, errors)
  api-client/     typed API client consumed by the web app
  ui/             shared UI primitives + design tokens
tests/e2e/        Playwright harness
infra/            infrastructure assets
scripts/          dev/CI helper scripts
```

## Prerequisites

- Node.js >= 20.11 (Corepack enabled)
- pnpm 9 (`corepack enable`)
- Docker + Docker Compose (for local infrastructure)

## Local development

```bash
# 1. Bring up infrastructure (PostgreSQL, Redis, MinIO + bucket, Mailpit)
cp .env.example .env
docker compose up -d
node scripts/check-infra.mjs        # optional: smoke-check the services

# 2. Install dependencies
pnpm install

# 3. Build workspace packages (apps consume the compiled packages)
pnpm build

# 4. Run the dev servers (api + worker + web)
pnpm dev
```

| Service       | URL                                 |
| ------------- | ----------------------------------- |
| Web console   | http://localhost:3000               |
| API           | http://localhost:3001/api/v1        |
| API health    | http://localhost:3001/api/v1/health |
| Swagger       | http://localhost:3001/api/docs      |
| MinIO console | http://localhost:9001               |
| Mailpit UI    | http://localhost:8025               |

## Quality gates

```bash
pnpm format:check   # Prettier
pnpm lint           # ESLint (incl. frontend→DB boundary rule)
pnpm typecheck      # tsc strict, noUncheckedIndexedAccess
pnpm test           # Vitest (unit + integration)
pnpm test:e2e       # Playwright harness
pnpm build          # turbo build (packages + apps)
```

Database lifecycle (schema, migrations, seed) is documented in
[`packages/database/README.md`](packages/database/README.md).
