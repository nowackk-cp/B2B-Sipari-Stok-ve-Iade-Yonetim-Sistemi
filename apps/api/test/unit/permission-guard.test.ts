import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './_fakes';
import { PRINCIPAL_KEY, type AuthPrincipal } from '../../src/common/auth/principal';
import { REQUIRED_PERMISSIONS_KEY } from '../../src/modules/authorization/authorization.constants';
import { InMemoryPermissionCache } from '../../src/modules/authorization/adapters/in-memory-permission-cache';
import {
  PermissionService,
  type PermissionSubject,
} from '../../src/modules/authorization/permission.service';
import { PermissionGuard } from '../../src/modules/authorization/guards/permission.guard';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { TestAuthzController } from '../support/test-authz.controller';
import { MergedAuthzProbeController } from '../support/merged-authz-probe.controller';

// NestJS stores @UseGuards on the handler under this metadata key, and @Module
// providers under this one.
const GUARDS_METADATA = '__guards__';
const PROVIDERS_METADATA = 'providers';

interface ClassProvider {
  provide?: unknown;
  useClass?: unknown;
}

/** APP_GUARD provider classes declared on a module, in declaration order. */
function appGuardClasses(moduleClass: object): unknown[] {
  const providers = (Reflect.getMetadata(PROVIDERS_METADATA, moduleClass) ?? []) as unknown[];
  return providers
    .filter((p): p is ClassProvider => typeof p === 'object' && p !== null)
    .filter((p) => p.provide === APP_GUARD)
    .map((p) => p.useClass);
}

/** Minimal fake repository so the service test needs no database. */
class FakeRepo {
  calls = 0;
  constructor(private codes: string[]) {}
  async loadEffectivePermissionCodes(): Promise<string[]> {
    this.calls += 1;
    return this.codes;
  }
  setCodes(codes: string[]): void {
    this.codes = codes;
  }
}

function makeService(repo: FakeRepo, clock = new FakeClock()): PermissionService {
  const cache = new InMemoryPermissionCache(clock);
  // The repo's only contract is loadEffectivePermissionCodes.
  return new PermissionService(repo as never, cache);
}

function ctxFor(handler: () => unknown, cls: unknown, req: unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

const SALES: PermissionSubject = { userId: 1n, roles: ['SALES'] };

describe('PermissionService (effective permission computation + cache)', () => {
  it('loads permissions from the source on a cold cache and caches the result', async () => {
    const repo = new FakeRepo(['product:read', 'order:read']);
    const service = makeService(repo);

    const first = await service.getEffectivePermissions(SALES);
    expect([...first].sort()).toEqual(['order:read', 'product:read']);
    expect(repo.calls).toBe(1);

    // Second call for the same (user, role-version) is served from cache.
    await service.getEffectivePermissions(SALES);
    expect(repo.calls).toBe(1);
  });

  it('de-duplicates permissions that arrive more than once', async () => {
    const repo = new FakeRepo(['product:read', 'product:read', 'order:read']);
    const service = makeService(repo);
    const set = await service.getEffectivePermissions(SALES);
    expect(set.size).toBe(2);
  });

  it('reflects a permission change after the cache is cleared', async () => {
    const repo = new FakeRepo(['product:read']);
    const cache = new InMemoryPermissionCache(new FakeClock());
    const service = new PermissionService(repo as never, cache);

    expect(await service.hasAllPermissions(SALES, ['product:create'])).toBe(false);
    repo.setCodes(['product:read', 'product:create']);
    // Still stale while cached (same role-version key)…
    expect(await service.hasAllPermissions(SALES, ['product:create'])).toBe(false);
    // …visible once the cache is cleared.
    await cache.clear();
    expect(await service.hasAllPermissions(SALES, ['product:create'])).toBe(true);
  });

  it('uses a fresh cache key when the role set changes', async () => {
    const repo = new FakeRepo(['product:read']);
    const service = makeService(repo);
    await service.getEffectivePermissions({ userId: 1n, roles: ['SALES'] });
    await service.getEffectivePermissions({ userId: 1n, roles: ['SALES', 'FINANCE'] });
    // Different role membership ⇒ different version ⇒ second DB load.
    expect(repo.calls).toBe(2);
  });

  it('hasAllPermissions requires every code (deny-by-default)', async () => {
    const repo = new FakeRepo(['order:create']);
    const service = makeService(repo);
    expect(await service.hasAllPermissions(SALES, ['order:create', 'order:approve'])).toBe(false);
    expect(await service.hasAllPermissions(SALES, ['order:create'])).toBe(true);
  });
});

describe('PermissionGuard', () => {
  const reflector = new Reflector();

  function guardWith(granted: boolean): PermissionGuard {
    const service = {
      async hasAllPermissions(): Promise<boolean> {
        return granted;
      },
    } as unknown as PermissionService;
    return new PermissionGuard(reflector, service);
  }

  const principal: AuthPrincipal = {
    userId: 1n,
    userPublicId: 'u-1',
    sessionId: 's-1',
    email: 'u@test.local',
    fullName: 'U',
    roles: ['SALES'],
  };

  it('allows a route that declares no permissions, even without a principal', async () => {
    const guard = guardWith(false);
    const ctx = ctxFor(TestAuthzController.prototype.publicRoute, TestAuthzController, {});
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('denies (401) a protected route with no authenticated principal', async () => {
    const guard = guardWith(true);
    const ctx = ctxFor(
      TestAuthzController.prototype.singlePermissionRoute,
      TestAuthzController,
      {},
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('denies (403) when the principal is missing a required permission', async () => {
    const guard = guardWith(false);
    const req = { [PRINCIPAL_KEY]: principal };
    const ctx = ctxFor(
      TestAuthzController.prototype.singlePermissionRoute,
      TestAuthzController,
      req,
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows when the principal holds the required permission', async () => {
    const guard = guardWith(true);
    const req = { [PRINCIPAL_KEY]: principal };
    const ctx = ctxFor(
      TestAuthzController.prototype.singlePermissionRoute,
      TestAuthzController,
      req,
    );
    expect(await guard.canActivate(ctx)).toBe(true);
  });
});

describe('PermissionGuard merges controller + handler metadata', () => {
  const reflector = new Reflector();

  const principal: AuthPrincipal = {
    userId: 1n,
    userPublicId: 'u-1',
    sessionId: 's-1',
    email: 'u@test.local',
    fullName: 'U',
    roles: ['SALES'],
  };

  /**
   * A guard whose permission service really evaluates `hasAllPermissions` against
   * a held set AND records every `required` list it was asked about — so a test
   * can assert both the access decision and the exact (merged, de-duplicated)
   * codes the guard enforced.
   */
  function recordingGuard(held: string[]): { guard: PermissionGuard; calls: string[][] } {
    const heldSet = new Set(held);
    const calls: string[][] = [];
    const service = {
      async hasAllPermissions(_subject: PermissionSubject, required: string[]): Promise<boolean> {
        calls.push(required);
        return required.every((code) => heldSet.has(code));
      },
    } as unknown as PermissionService;
    return { guard: new PermissionGuard(reflector, service), calls };
  }

  const reqWithPrincipal = { [PRINCIPAL_KEY]: principal };

  it('1. requires BOTH the controller and handler permissions (order:read + order:approve)', async () => {
    const { guard, calls } = recordingGuard(['order:read', 'order:approve']);
    const ctx = ctxFor(
      MergedAuthzProbeController.prototype.approve,
      MergedAuthzProbeController,
      reqWithPrincipal,
    );
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(calls).toHaveLength(1);
    expect([...(calls[0] ?? [])].sort()).toEqual(['order:approve', 'order:read']);
  });

  it('2. denies (403) a user holding only the controller permission (order:read)', async () => {
    const { guard } = recordingGuard(['order:read']);
    const ctx = ctxFor(
      MergedAuthzProbeController.prototype.approve,
      MergedAuthzProbeController,
      reqWithPrincipal,
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('3. denies (403) a user holding only the handler permission (order:approve)', async () => {
    const { guard } = recordingGuard(['order:approve']);
    const ctx = ctxFor(
      MergedAuthzProbeController.prototype.approve,
      MergedAuthzProbeController,
      reqWithPrincipal,
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('4. allows a user holding both the controller and handler permissions', async () => {
    const { guard } = recordingGuard(['order:read', 'order:approve']);
    const ctx = ctxFor(
      MergedAuthzProbeController.prototype.approve,
      MergedAuthzProbeController,
      reqWithPrincipal,
    );
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('5. de-duplicates a code declared on both controller and handler (checked once)', async () => {
    const { guard, calls } = recordingGuard(['order:read']);
    const ctx = ctxFor(
      MergedAuthzProbeController.prototype.duplicate,
      MergedAuthzProbeController,
      reqWithPrincipal,
    );
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['order:read']);
  });

  it('6. applies only the controller permission when the handler declares none', async () => {
    const { guard, calls } = recordingGuard(['order:read']);
    const ctx = ctxFor(
      MergedAuthzProbeController.prototype.inherited,
      MergedAuthzProbeController,
      reqWithPrincipal,
    );
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(calls[0]).toEqual(['order:read']);
    // …and a user without it is denied.
    const denied = recordingGuard([]);
    await expect(
      denied.guard.canActivate(
        ctxFor(
          MergedAuthzProbeController.prototype.inherited,
          MergedAuthzProbeController,
          reqWithPrincipal,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('7. applies only the handler permission when the controller declares none', async () => {
    const { guard, calls } = recordingGuard(['product:read']);
    const ctx = ctxFor(
      TestAuthzController.prototype.singlePermissionRoute,
      TestAuthzController,
      reqWithPrincipal,
    );
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(calls[0]).toEqual(['product:read']);
  });

  it('8. performs no permission check when neither level declares metadata', async () => {
    const { guard, calls } = recordingGuard([]);
    const ctx = ctxFor(TestAuthzController.prototype.publicRoute, TestAuthzController, {});
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('route ↔ permission metadata coverage', () => {
  const reflector = new Reflector();

  it('reads the declared permissions off each protected route', () => {
    expect(
      reflector.get<string[]>(
        REQUIRED_PERMISSIONS_KEY,
        TestAuthzController.prototype.singlePermissionRoute,
      ),
    ).toEqual(['product:read']);
    expect(
      reflector.get<string[]>(
        REQUIRED_PERMISSIONS_KEY,
        TestAuthzController.prototype.multiplePermissionRoute,
      ),
    ).toEqual(['order:create', 'order:approve']);
  });

  it('flags a route that declares a permission but omits the PermissionGuard', () => {
    const offenders = findRoutesMissingPermissionGuard(TestAuthzController);
    expect(offenders).toContain('unguardedProtectedRoute');
    // Properly guarded routes are not flagged.
    expect(offenders).not.toContain('singlePermissionRoute');
    expect(offenders).not.toContain('multiplePermissionRoute');
    expect(offenders).not.toContain('systemRoute');
  });
});

describe('global guard registration (production AppModule)', () => {
  it('binds PermissionGuard as an APP_GUARD exactly once', () => {
    const guards = appGuardClasses(AppModule);
    expect(guards.filter((g) => g === PermissionGuard)).toHaveLength(1);
  });

  it('runs authentication before authorization (JwtAuthGuard ordered first)', () => {
    const guards = appGuardClasses(AppModule);
    const authIndex = guards.indexOf(JwtAuthGuard);
    const permIndex = guards.indexOf(PermissionGuard);
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(permIndex).toBeGreaterThan(authIndex);
  });

  it('does not register JwtAuthGuard as a global guard more than once', () => {
    const guards = appGuardClasses(AppModule);
    expect(guards.filter((g) => g === JwtAuthGuard)).toHaveLength(1);
  });
});

/**
 * Coverage scanner (the seed of the future route↔permission drift test,
 * PERMISSION_MATRIX §3): any handler that declares `@RequirePermissions` but does
 * not list `PermissionGuard` in its `@UseGuards` is an unprotected protected
 * route and is returned here.
 */
function findRoutesMissingPermissionGuard(controller: new (...args: never[]) => object): string[] {
  const proto = controller.prototype as Record<string, unknown>;
  const offenders: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = proto[name];
    if (typeof handler !== 'function') continue;
    const required = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler) as string[] | undefined;
    if (!required || required.length === 0) continue;
    const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? [];
    if (!guards.includes(PermissionGuard)) offenders.push(name);
  }
  return offenders;
}
