import type { ComponentHealth } from '@b2b/contracts';

/**
 * A readiness probe for a single dependency (DB, Redis, storage, ...).
 * New indicators are registered into {@link HEALTH_INDICATORS} as the platform
 * grows; the health module aggregates them without further changes.
 */
export interface HealthIndicator {
  readonly name: string;
  check(): Promise<ComponentHealth> | ComponentHealth;
}
