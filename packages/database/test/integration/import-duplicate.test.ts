import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, makeCompany, makeFile, uniqueSuffix } from './helpers';

/**
 * DBF-005: at most one in-flight import per (company, file checksum), enforced
 * by a partial unique index over the active statuses. Terminal imports can be
 * retried as a new attempt linked via replay_of_import_id.
 */
describe('import duplicate policy', () => {
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

  async function newJob(companyId: bigint, checksum: string, status?: string) {
    const { file, user } = await makeFile(prisma);
    return prisma.importJob.create({
      data: {
        companyId,
        type: 'PRODUCT',
        sourceFileId: file.id,
        fileChecksumSha256: checksum,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(status ? { status: status as any } : {}),
        createdById: user.id,
      },
    });
  }

  it('rejects two active imports with the same (company, checksum)', async () => {
    const company = await makeCompany(prisma);
    const checksum = `sha_${uniqueSuffix()}`;
    await newJob(company.id, checksum); // UPLOADED (active)
    await expect(newJob(company.id, checksum)).rejects.toThrow();
  });

  it('allows a replay after the first import reaches a terminal state', async () => {
    const company = await makeCompany(prisma);
    const checksum = `sha_${uniqueSuffix()}`;
    const first = await newJob(company.id, checksum);
    await prisma.importJob.update({ where: { id: first.id }, data: { status: 'COMPLETED' } });

    const { file, user } = await makeFile(prisma);
    const replay = await prisma.importJob.create({
      data: {
        companyId: company.id,
        type: 'PRODUCT',
        sourceFileId: file.id,
        fileChecksumSha256: checksum,
        replayOfImportId: first.id,
        attemptNumber: 2,
        createdById: user.id,
      },
    });
    expect(replay.replayOfImportId).toBe(first.id);
    expect(replay.attemptNumber).toBe(2);
  });

  it('links a replay back to its original import', async () => {
    const company = await makeCompany(prisma);
    const checksum = `sha_${uniqueSuffix()}`;
    const first = await newJob(company.id, checksum, 'IMPORT_FAILED');
    const replay = await newJob(company.id, checksum); // active again, allowed (first terminal)
    await prisma.importJob.update({
      where: { id: replay.id },
      data: { replayOfImportId: first.id },
    });
    const loaded = await prisma.importJob.findUnique({
      where: { id: replay.id },
      include: { replayOf: true },
    });
    expect(loaded?.replayOf?.id).toBe(first.id);
  });

  it('cannot apply the same import row idempotency key twice', async () => {
    const company = await makeCompany(prisma);
    const job = await newJob(company.id, `sha_${uniqueSuffix()}`);
    const key = `IMPORT:${job.id}:1`;
    await prisma.importRow.create({
      data: { importJobId: job.id, rowNumber: 1, rowHash: 'h', idempotencyKey: key, rawData: {} },
    });
    await expect(
      prisma.importRow.create({
        data: { importJobId: job.id, rowNumber: 2, rowHash: 'h', idempotencyKey: key, rawData: {} },
      }),
    ).rejects.toThrow();
  });

  it('serialises concurrent duplicate uploads — exactly one wins', async () => {
    const company = await makeCompany(prisma);
    const checksum = `sha_${uniqueSuffix()}`;
    const results = await Promise.allSettled([
      newJob(company.id, checksum),
      newJob(company.id, checksum),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
