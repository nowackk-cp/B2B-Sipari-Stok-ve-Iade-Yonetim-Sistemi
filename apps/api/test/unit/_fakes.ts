import type { AppConfigService } from '../../src/common/config/app-config.service';
import type { Clock } from '../../src/common/time/clock';

/** Minimal controllable clock for unit tests. */
export class FakeClock implements Clock {
  constructor(private current = new Date('2026-06-15T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  set(date: Date): void {
    this.current = date;
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Build a partial AppConfigService stub exposing only the getters under test. */
export function fakeConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  const base = {
    argon2: { memoryKiB: 8192, iterations: 2, parallelism: 1 },
    jwtAccessSecret: 'unit-test-access-secret-at-least-32-characters',
    jwtAccessTtlSeconds: 900,
    jwtIssuer: 'b2b-operations-suite',
    jwtAudience: 'b2b-api',
    refreshTokenTtlDays: 30,
    isProduction: false,
    refreshCookie: {
      name: 'b2b_refresh_token',
      path: '/api/v1/auth',
      secure: false,
      domain: undefined,
      maxAgeSeconds: 30 * 24 * 60 * 60,
    },
  };
  return { ...base, ...overrides } as unknown as AppConfigService;
}
