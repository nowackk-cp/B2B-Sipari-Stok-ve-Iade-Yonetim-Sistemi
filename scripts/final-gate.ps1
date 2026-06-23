# =============================================================================
# final-gate.ps1 — run the full release gate in order, stopping on first failure.
# =============================================================================
# A thin, auditable wrapper over the SAME pnpm scripts documented in
# docs/demo/DEMO_RUNBOOK.md §10 / docs/reviews/FINAL_PROJECT_STATUS.md §5. It
# changes no behaviour — it only sequences the gates and fails closed.
#
# Backend/DB and E2E gates need a REAL PostgreSQL *test* database. Set these
# before running (names MUST contain "test" or the seeds refuse to run):
#
#   $env:DATABASE_URL        = 'postgresql://b2b:b2b@127.0.0.1:55432/b2b_gate_test?schema=public'
#   $env:SHADOW_DATABASE_URL = 'postgresql://b2b:b2b@127.0.0.1:55432/b2b_gate_shadow_test?schema=public'
#
# Usage:
#   pwsh scripts/final-gate.ps1            # full gate (backend + frontend + root)
#   pwsh scripts/final-gate.ps1 -SkipE2e   # skip the Playwright browser smoke
#   pwsh scripts/final-gate.ps1 -SkipBackend  # frontend + root only (no PostgreSQL)
#
# Redis is NOT required: the API gate uses an in-memory rate limiter and the app
# login throttle fails open (PostgreSQL lockout stays authoritative). Provision
# Redis for production runtime, not for this gate.
# =============================================================================
[CmdletBinding()]
param(
  [switch]$SkipE2e,
  [switch]$SkipBackend
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$script:step = 0
function Invoke-Gate {
  param([string]$Name, [scriptblock]$Cmd)
  $script:step++
  Write-Host "`n=== [$script:step] $Name ===" -ForegroundColor Cyan
  & $Cmd
  if ($LASTEXITCODE -ne 0) {
    Write-Host "✖ GATE FAILED: $Name (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
  Write-Host "✓ $Name" -ForegroundColor Green
}

if (-not $SkipBackend) {
  if (-not $env:DATABASE_URL) { Write-Host '✖ DATABASE_URL is required for the backend gate (real test PostgreSQL).' -ForegroundColor Red; exit 1 }
  if ($env:DATABASE_URL -notmatch 'test') { Write-Host '✖ DATABASE_URL must point at a *test* database (name must contain "test").' -ForegroundColor Red; exit 1 }

  Invoke-Gate 'DB: migrate deploy (clean)'  { pnpm.cmd --filter @b2b/database exec prisma migrate deploy }
  Invoke-Gate 'DB: migrate deploy (2nd, idempotent)' { pnpm.cmd --filter @b2b/database exec prisma migrate deploy }
  Invoke-Gate 'DB: seed (run 1)'            { pnpm.cmd --filter @b2b/database db:seed }
  Invoke-Gate 'DB: seed (run 2, idempotent)' { pnpm.cmd --filter @b2b/database db:seed }
  Invoke-Gate 'DB: drift'                   { pnpm.cmd --filter @b2b/database db:drift }
  Invoke-Gate 'DB: verify-catalog'          { pnpm.cmd --filter @b2b/database db:verify-catalog }
  Invoke-Gate 'DB: prisma validate'         { pnpm.cmd --filter @b2b/database exec prisma validate }
  Invoke-Gate 'DB: database gate (real PostgreSQL)' { pnpm.cmd --filter @b2b/database test:database-gate }
  Invoke-Gate 'API: integration gate (real PostgreSQL)' { pnpm.cmd --filter @b2b/api test:integration }
}

# Frontend + repo-wide (no external services required).
Invoke-Gate 'Web: unit/component tests'     { pnpm.cmd --filter @b2b/web test }
Invoke-Gate 'Root: typecheck'               { pnpm.cmd typecheck }
Invoke-Gate 'Root: lint'                     { pnpm.cmd lint }
Invoke-Gate 'Root: build'                    { pnpm.cmd build }
Invoke-Gate 'Root: format:check'             { pnpm.cmd format:check }
Invoke-Gate 'Root: check:docs'               { pnpm.cmd check:docs }
Invoke-Gate 'Root: check:no-skip'            { pnpm.cmd check:no-skip }
Invoke-Gate 'Root: check:boundaries'         { pnpm.cmd check:boundaries }
Invoke-Gate 'Root: check:secrets'            { pnpm.cmd check:secrets }

if (-not $SkipE2e -and -not $SkipBackend) {
  # Boots the built API + a freshly-built Next server against the test DB and
  # seeds the E2E user (company + SYSTEM_ADMIN role + warehouse scope).
  Invoke-Gate 'Web: E2E smoke (real stack)'  { pnpm.cmd --filter @b2b/web test:e2e }
}

Write-Host "`n✓ ALL GATES PASSED" -ForegroundColor Green
