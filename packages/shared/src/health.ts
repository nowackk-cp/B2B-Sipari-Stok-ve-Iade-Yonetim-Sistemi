/** Health state of the service or one of its dependencies. */
export type HealthState = 'ok' | 'degraded' | 'error';

/** Health of a single downstream dependency (DB, Redis, storage, ...). */
export interface ComponentHealth {
  status: HealthState;
  detail?: string;
}

/**
 * Liveness/readiness payload returned by the health endpoints.
 * `details` is populated by readiness checks (dependency probes).
 */
export interface HealthStatus {
  status: HealthState;
  service: string;
  version: string;
  timestamp: string;
  environment: string;
  details?: Record<string, ComponentHealth>;
}
