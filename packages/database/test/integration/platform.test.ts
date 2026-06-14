import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, dbConfigured, makeUser, uniqueSuffix } from './helpers';

describe.skipIf(!dbConfigured)('platform — outbox / effects / imports', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('rejects a duplicate outbox deduplication key', async () => {
    const key = `evt:${uniqueSuffix()}`;
    await prisma.outboxEvent.create({
      data: {
        eventType: 'invoice.issued',
        aggregateType: 'INVOICE',
        aggregateId: 1n,
        deduplicationKey: key,
        payload: {},
      },
    });
    await expect(
      prisma.outboxEvent.create({
        data: {
          eventType: 'invoice.issued',
          aggregateType: 'INVOICE',
          aggregateId: 2n,
          deduplicationKey: key,
          payload: {},
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate effect key (effect_type, effect_key)', async () => {
    const effectKey = `EMAIL:${uniqueSuffix()}`;
    await prisma.effectReceipt.create({
      data: { effectType: 'EMAIL', effectKey, providerIdempotencyKey: 'p1' },
    });
    await expect(
      prisma.effectReceipt.create({
        data: { effectType: 'EMAIL', effectKey, providerIdempotencyKey: 'p2' },
      }),
    ).rejects.toThrow();
  });

  it('rejects an invalid effect status value (enum)', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO effect_receipts (effect_type, effect_key, provider_idempotency_key, status, attempts, created_at, updated_at)
         VALUES ('EMAIL', 'k_${Date.now()}', 'p', 'NOT_A_STATUS', 0, now(), now())`,
      ),
    ).rejects.toThrow();
  });

  it('has the required outbox/effect indexes', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('outbox_events','effect_receipts')
    `;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('outbox_events_status_available_at_idx');
    expect(names).toContain('outbox_events_deduplication_key_key');
    expect(names).toContain('effect_receipts_effect_type_effect_key_key');
    expect(names).toContain('effect_receipts_status_idx');
  });

  async function makeFile() {
    const user = await makeUser(prisma);
    const file = await prisma.file.create({
      data: {
        storageKey: `key/${uniqueSuffix()}`,
        bucket: 'imports',
        filename: 'in.xlsx',
        contentType: 'application/vnd.ms-excel',
        sizeBytes: 10n,
        uploadedById: user.id,
      },
    });
    return { file, user };
  }

  it('rejects a duplicate import row idempotency key', async () => {
    const { file, user } = await makeFile();
    const job = await prisma.importJob.create({
      data: {
        type: 'PRODUCT',
        sourceFileId: file.id,
        fileChecksumSha256: `c_${uniqueSuffix()}`,
        createdById: user.id,
      },
    });
    const key = `IMPORT:${job.id}:1`;
    await prisma.importRow.create({
      data: { importJobId: job.id, rowNumber: 1, rowHash: 'h', idempotencyKey: key, rawData: {} },
    });
    await expect(
      prisma.importRow.create({
        data: {
          importJobId: job.id,
          rowNumber: 2,
          rowHash: 'h2',
          idempotencyKey: key,
          rawData: {},
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate (import_job, row_number)', async () => {
    const { file, user } = await makeFile();
    const job = await prisma.importJob.create({
      data: {
        type: 'PRODUCT',
        sourceFileId: file.id,
        fileChecksumSha256: `c_${uniqueSuffix()}`,
        createdById: user.id,
      },
    });
    await prisma.importRow.create({
      data: {
        importJobId: job.id,
        rowNumber: 1,
        rowHash: 'h',
        idempotencyKey: `IMPORT:${job.id}:a`,
        rawData: {},
      },
    });
    await expect(
      prisma.importRow.create({
        data: {
          importJobId: job.id,
          rowNumber: 1,
          rowHash: 'h',
          idempotencyKey: `IMPORT:${job.id}:b`,
          rawData: {},
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects an invalid import status value (enum)', async () => {
    const { file, user } = await makeFile();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO import_jobs (type, source_file_id, file_checksum_sha256, status, apply_policy, total_rows, valid_rows, invalid_rows, applied_rows, created_by, created_at, updated_at)
         VALUES ('PRODUCT', ${file.id}, 'c_${Date.now()}', 'BOGUS', 'ALL_OR_NOTHING', 0,0,0,0, ${user.id}, now(), now())`,
      ),
    ).rejects.toThrow();
  });
});
