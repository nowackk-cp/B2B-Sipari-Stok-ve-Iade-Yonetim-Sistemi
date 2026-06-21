import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { ProductImportResultView } from '@b2b/contracts';
import { AuditWriter } from '../../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../../common/auth/principal';
import type { RequestMeta } from '../../../common/http/request-meta';
import { CLOCK, type Clock } from '../../../common/time/clock';
import { PrismaService } from '../../../common/database/prisma.service';
import { CsvParseError, parseCsv } from './product-csv';
import {
  ImportHeaderError,
  validateHeader,
  validateRows,
  type ValidatedImportRow,
} from './product-import.parser';
import { ProductImportRepository } from './product-import.repository';

/** The minimal shape this service needs from a multipart upload (multer). */
export interface UploadedCsvFile {
  buffer: Buffer;
  originalname?: string;
  mimetype?: string;
  size: number;
}

/**
 * Product CSV import application service (Product Import/Export Foundation).
 *
 * Synchronous + all-or-nothing: the whole file is parsed and validated up front;
 * if ANY row is invalid the request fails (422) and NOTHING is written — no
 * products, no import record, no audit. Only on a fully-valid file does one
 * transaction create the source-file record, the COMPLETED import job, every
 * product, and the single summary business-audit row (ADR-007). The owning
 * tenant is ALWAYS the actor's real company; a `companyId` column or body field
 * is rejected, never trusted.
 */
@Injectable()
export class ProductImportService {
  constructor(
    private readonly repo: ProductImportRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async import(
    actor: AuthPrincipal,
    file: UploadedCsvFile | undefined,
    meta: RequestMeta,
  ): Promise<ProductImportResultView> {
    if (!file || file.size === 0 || file.buffer.length === 0) {
      throw new BadRequestException('A non-empty CSV file is required (multipart field "file").');
    }

    const parsed = this.parseOrThrow(file.buffer);
    const columns = this.headerOrThrow(parsed.header);
    if (parsed.rows.length === 0) {
      throw new BadRequestException('The file has a header but no data rows.');
    }

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    if (await this.repo.hasCompletedImport(actor.companyId, checksum)) {
      throw new ConflictException('This exact file has already been imported into this company.');
    }

    const skus = parsed.rows
      .map((r) => {
        const i = columns.get('sku');
        return i === undefined ? '' : (r[i] ?? '').trim();
      })
      .filter((s) => s !== '');
    const existing = await this.repo.existingActiveSkus(actor.companyId, skus);

    const { rows, errors } = validateRows(parsed, columns, existing);
    if (errors.length > 0) {
      // 422 + per-row messages (problem+json `errors[]`). All-or-nothing: the
      // failure path writes no product, no import record and no audit row.
      throw new UnprocessableEntityException({
        message: errors.map(
          (e) => `Row ${e.row}${e.column ? `, column ${e.column}` : ''}: ${e.message}`,
        ),
        error: 'IMPORT_VALIDATION_FAILED',
      });
    }

    const createdAt = this.clock.now();
    const filePublicId = await this.apply(actor, file, checksum, rows, meta);

    return {
      id: filePublicId,
      status: 'COMPLETED',
      checksum,
      totalRows: parsed.rows.length,
      validRows: rows.length,
      invalidRows: 0,
      appliedRows: rows.length,
      errors: [],
      createdAt: createdAt.toISOString(),
    };
  }

  /** Fetch a previously-completed import by its public (source-file) id. */
  async getOne(actor: AuthPrincipal, publicId: string): Promise<ProductImportResultView> {
    const job = await this.repo.findByFilePublicId(actor.companyId, publicId);
    if (!job) throw new NotFoundException('Import not found');
    return {
      id: job.publicId,
      status: job.status === 'COMPLETED' ? 'COMPLETED' : 'VALIDATION_FAILED',
      checksum: job.fileChecksumSha256,
      totalRows: job.totalRows,
      validRows: job.validRows,
      invalidRows: job.invalidRows,
      appliedRows: job.appliedRows,
      errors: [],
      createdAt: job.createdAt.toISOString(),
    };
  }

  // --- internals -----------------------------------------------------------

  /** The atomic apply: file + job + products + audit, all in one transaction. */
  private async apply(
    actor: AuthPrincipal,
    file: UploadedCsvFile,
    checksum: string,
    rows: ValidatedImportRow[],
    meta: RequestMeta,
  ): Promise<string> {
    try {
      return await this.prisma.transaction(async (tx) => {
        const fileRow = await this.repo.createSourceFile(
          {
            filename: file.originalname ?? 'products.csv',
            contentType: file.mimetype ?? 'text/csv',
            sizeBytes: file.size,
            checksum,
          },
          actor.userId,
          tx,
        );
        const job = await this.repo.createJob(
          {
            companyId: actor.companyId,
            sourceFileId: fileRow.id,
            checksum,
            totalRows: rows.length,
            validRows: rows.length,
          },
          actor.userId,
          tx,
        );
        const applied = await this.repo.insertProducts(actor.companyId, rows, tx);
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.PRODUCT_IMPORTED,
          actor: {
            id: actor.userId,
            email: actor.email,
            name: actor.fullName,
            rolesSnapshot: actor.roles,
          },
          entityType: 'product_import',
          entityId: job.id,
          after: {
            checksum,
            filename: file.originalname ?? 'products.csv',
            totalRows: rows.length,
            appliedRows: applied,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        await this.repo.completeJob(job.id, applied, tx);
        return fileRow.publicId;
      });
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  private parseOrThrow(buffer: Buffer): ReturnType<typeof parseCsv> {
    try {
      return parseCsv(buffer.toString('utf8'));
    } catch (err) {
      if (err instanceof CsvParseError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  private headerOrThrow(header: string[]): Map<string, number> {
    try {
      return validateHeader(header);
    } catch (err) {
      if (err instanceof ImportHeaderError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** A unique violation under load (racing duplicate file, or a SKU that slipped
   * past the pre-check) maps to 409 — never an opaque 500. */
  private mapWriteError(err: unknown): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(
        'A conflicting product or import already exists (duplicate SKU or concurrent import of the same file).',
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
