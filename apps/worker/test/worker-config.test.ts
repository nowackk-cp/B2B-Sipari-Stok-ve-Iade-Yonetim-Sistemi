import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '@b2b/config';
import { WorkerConfigModule } from '../src/common/config/worker-config.module';
import { WorkerConfigService } from '../src/common/config/worker-config.service';
import { WORKER_IDENTITY } from '../src/worker.constants';
import { buildWorkerIdentity, type WorkerIdentity } from '../src/identity';

describe('worker identity', () => {
  it('derives instanceId from hostname and pid when none is configured', () => {
    const identity = buildWorkerIdentity({ WORKER_INSTANCE_ID: undefined });
    expect(identity.instanceId).toContain(String(process.pid));
    expect(identity.pid).toBe(process.pid);
    expect(() => new Date(identity.startedAt).toISOString()).not.toThrow();
  });

  it('uses the explicit WORKER_INSTANCE_ID when provided', () => {
    const identity = buildWorkerIdentity({ WORKER_INSTANCE_ID: 'pod-7' });
    expect(identity.instanceId).toBe('pod-7');
  });
});

describe('worker config', () => {
  it('applies BullMQ defaults from the validated env', () => {
    const config = loadWorkerConfig(process.env);
    expect(config.WORKER_CONCURRENCY).toBe(5);
    expect(config.WORKER_QUEUE_PREFIX).toBe('b2b');
  });
});

describe('worker config module (DI initialization)', () => {
  let moduleRef:
    | Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>
    | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('provides a validated config service and a resolved identity', async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerConfigModule] }).compile();

    const config = moduleRef.get(WorkerConfigService);
    expect(config.concurrency).toBe(5);
    expect(config.queuePrefix).toBe('b2b');
    expect(config.redisUrl).toMatch(/^redis:\/\//);

    const identity = moduleRef.get<WorkerIdentity>(WORKER_IDENTITY);
    expect(identity.instanceId.length).toBeGreaterThan(0);
    expect(identity.hostname.length).toBeGreaterThan(0);
  });
});
