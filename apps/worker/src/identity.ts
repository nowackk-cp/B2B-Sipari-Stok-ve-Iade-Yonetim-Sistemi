import { hostname } from 'node:os';
import type { WorkerConfig } from '@b2b/config';

/** Stable identity of a single worker process within a horizontally-scaled pool. */
export interface WorkerIdentity {
  instanceId: string;
  hostname: string;
  pid: number;
  startedAt: string;
}

/**
 * Resolve this worker's identity. Uses the explicit `WORKER_INSTANCE_ID` when
 * provided (e.g. a stable pod name), otherwise derives one from host + pid.
 */
export function buildWorkerIdentity(
  config: Pick<WorkerConfig, 'WORKER_INSTANCE_ID'>,
): WorkerIdentity {
  const host = hostname();
  return {
    instanceId: config.WORKER_INSTANCE_ID ?? `${host}-${process.pid}`,
    hostname: host,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}
