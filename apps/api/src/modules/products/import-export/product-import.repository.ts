import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DbClient } from '../../../common/database/db-client';
import { PrismaService } from '../../../common/database/prisma.service';
import type { ValidatedImportRow } from './product-import.parser';

/** Whitelisted projection of a persisted import job (success path only). */
export interface ImportJobRow {
  id: bigint;
  publicId: string;
  status: string;
  fileChecksumSha256: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  appliedRows: number;
  createdAt: Date;
}

/**
 * Data access for product CSV imports. Owns the bookkeeping writes against the
 * shared M12/M14 tables (`files`, `import_jobs`) plus the bulk product insert, so
 * the whole import — file record, job record, products and audit — commits as one
 * unit (all-or-nothing). Every method takes an explicit executor so it composes
 * inside the service's single transaction, and every query is company-scoped.
 *
 * The import's PUBLIC identity is its source file's UUID (`files.public_id`):
 * `import_jobs` has no public id of its own, and exposing its sequential PK would
 * leak an internal key (API_CONVENTIONS §7a). No durable blob storage exists yet,
 * so the file row is metadata-only (`bucket = 'inline'`) — see the task report.
 */
@Injectable()
export class ProductImportRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** The subset of `skus` that already exist as ACTIVE (not soft-deleted)
   * products in the company — used to flag duplicate-SKU rows before applying. */
  async existingActiveSkus(
    companyId: bigint,
    skus: string[],
    executor?: DbClient,
  ): Promise<Set<string>> {
    if (skus.length === 0) return new Set();
    const rows = await this.db(executor).product.findMany({
      where: { companyId, deletedAt: null, sku: { in: skus } },
      select: { sku: true },
    });
    return new Set(rows.map((r) => r.sku));
  }

  /** Whether a COMPLETED product import for this exact file checksum already
   * exists in the company (the duplicate-file policy → 409). */
  async hasCompletedImport(
    companyId: bigint,
    checksum: string,
    executor?: DbClient,
  ): Promise<boolean> {
    const row = await this.db(executor).importJob.findFirst({
      where: { companyId, type: 'PRODUCT', fileChecksumSha256: checksum, status: 'COMPLETED' },
      select: { id: true },
    });
    return row !== null;
  }

  /** Create the metadata-only source file row (no durable blob backing yet). */
  async createSourceFile(
    params: { filename: string; contentType: string; sizeBytes: number; checksum: string },
    uploadedById: bigint,
    executor: DbClient,
  ): Promise<{ id: bigint; publicId: string }> {
    return executor.file.create({
      data: {
        storageKey: `inline://product-import/${randomUUID()}`,
        bucket: 'inline',
        filename: params.filename,
        contentType: params.contentType,
        sizeBytes: BigInt(params.sizeBytes),
        checksumSha256: params.checksum,
        entityType: 'product_import',
        uploadedById,
      },
      select: { id: true, publicId: true },
    });
  }

  /**
   * Create the import job in the active VALIDATING state. The partial-unique
   * `import_jobs_active_checksum_key` serialises concurrent uploads of the same
   * file (exactly one active job per company+checksum), so a racing duplicate
   * fails with P2002 — mapped to 409 by the caller.
   */
  async createJob(
    params: {
      companyId: bigint;
      sourceFileId: bigint;
      checksum: string;
      totalRows: number;
      validRows: number;
    },
    createdById: bigint,
    executor: DbClient,
  ): Promise<{ id: bigint }> {
    return executor.importJob.create({
      data: {
        companyId: params.companyId,
        type: 'PRODUCT',
        sourceFileId: params.sourceFileId,
        fileChecksumSha256: params.checksum,
        status: 'VALIDATING',
        applyPolicy: 'ALL_OR_NOTHING',
        totalRows: params.totalRows,
        validRows: params.validRows,
        invalidRows: params.totalRows - params.validRows,
        createdById,
      },
      select: { id: true },
    });
  }

  /** Bulk-insert the validated rows as products of the company (one statement). */
  async insertProducts(
    companyId: bigint,
    rows: ValidatedImportRow[],
    executor: DbClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await executor.product.createMany({
      data: rows.map((r) => ({
        companyId,
        sku: r.sku,
        name: r.name,
        description: r.description,
        currency: r.currency,
        listPriceAmount: r.listPriceAmount,
        taxRateBp: r.taxRateBp,
        criticalStockThreshold: r.criticalStockThreshold,
        isActive: r.isActive,
      })),
    });
    return result.count;
  }

  /** Mark the job COMPLETED with the applied-row count (terminal state). */
  async completeJob(jobId: bigint, appliedRows: number, executor: DbClient): Promise<void> {
    await executor.importJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', appliedRows },
    });
  }

  /** Find a persisted import job in the company by its source file's public id. */
  async findByFilePublicId(
    companyId: bigint,
    filePublicId: string,
    executor?: DbClient,
  ): Promise<ImportJobRow | null> {
    const job = await this.db(executor).importJob.findFirst({
      where: { companyId, sourceFile: { publicId: filePublicId } },
      select: {
        id: true,
        status: true,
        fileChecksumSha256: true,
        totalRows: true,
        validRows: true,
        invalidRows: true,
        appliedRows: true,
        createdAt: true,
        sourceFile: { select: { publicId: true } },
      },
    });
    if (!job) return null;
    return {
      id: job.id,
      publicId: job.sourceFile.publicId,
      status: job.status,
      fileChecksumSha256: job.fileChecksumSha256,
      totalRows: job.totalRows,
      validRows: job.validRows,
      invalidRows: job.invalidRows,
      appliedRows: job.appliedRows,
      createdAt: job.createdAt,
    };
  }
}
