import { Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** Internal, fully-typed product record. Never returned to clients directly —
 * the controller maps it to the whitelisted {@link ProductView} contract. */
export interface ProductRow {
  id: bigint;
  publicId: string;
  companyId: bigint;
  sku: string;
  name: string;
  description: string | null;
  barcode: string | null;
  unit: string;
  categoryId: bigint | null;
  listPriceAmount: bigint;
  currency: string;
  taxRateBp: number;
  criticalStockThreshold: bigint | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const SELECT = {
  id: true,
  publicId: true,
  companyId: true,
  sku: true,
  name: true,
  description: true,
  barcode: true,
  unit: true,
  categoryId: true,
  listPriceAmount: true,
  currency: true,
  taxRateBp: true,
  criticalStockThreshold: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

/** Mutable product fields a create/update may set (already validated/normalised). */
export interface ProductWriteData {
  sku?: string;
  name?: string;
  description?: string | null;
  barcode?: string | null;
  unit?: string;
  categoryId?: bigint | null;
  listPriceAmount?: bigint;
  currency?: string;
  taxRateBp?: number;
  criticalStockThreshold?: bigint | null;
  isActive?: boolean;
}

export interface ListProductsOptions {
  /** Exclusive lower-bound id (rows with id > cursorId), for cursor pagination. */
  cursorId?: bigint;
  /** Number of rows to fetch (callers pass limit+1 to detect a next page). */
  take: number;
  /** Case-insensitive substring over sku/name. */
  search?: string;
  isActive?: boolean;
  categoryId?: bigint;
}

/**
 * Data access for the catalog `products` table (MODULE_BOUNDARIES §2). Every
 * method takes an explicit executor so it composes inside a caller's
 * transaction, and EVERY query is scoped to a `companyId` — tenant isolation is
 * enforced here as well as by the DB composite key, so one company can never
 * read or mutate another's products. Reads exclude soft-deleted rows.
 */
@Injectable()
export class ProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  async create(companyId: bigint, data: ProductWriteData, executor: DbClient): Promise<ProductRow> {
    return executor.product.create({
      data: {
        companyId,
        sku: data.sku as string,
        name: data.name as string,
        description: data.description ?? null,
        barcode: data.barcode ?? null,
        unit: data.unit,
        categoryId: data.categoryId ?? null,
        listPriceAmount: data.listPriceAmount,
        currency: data.currency,
        taxRateBp: data.taxRateBp,
        criticalStockThreshold: data.criticalStockThreshold ?? null,
        isActive: data.isActive,
      },
      select: SELECT,
    });
  }

  /** Find an ACTIVE (not soft-deleted) product by public id WITHIN a company. */
  async findActiveByPublicId(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<ProductRow | null> {
    return this.db(executor).product.findFirst({
      where: { publicId, companyId, deletedAt: null },
      select: SELECT,
    });
  }

  /** Page of active products for a company (ordered by id asc; cursor-friendly). */
  async list(
    companyId: bigint,
    opts: ListProductsOptions,
    executor?: DbClient,
  ): Promise<ProductRow[]> {
    const where: Prisma.ProductWhereInput = { companyId, deletedAt: null };
    if (opts.cursorId !== undefined) where.id = { gt: opts.cursorId };
    if (opts.isActive !== undefined) where.isActive = opts.isActive;
    if (opts.categoryId !== undefined) where.categoryId = opts.categoryId;
    if (opts.search) {
      where.OR = [
        { sku: { contains: opts.search, mode: 'insensitive' } },
        { name: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    return this.db(executor).product.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
      select: SELECT,
    });
  }

  /**
   * All active (not soft-deleted) products of a company matching the export
   * filters, ordered by SKU, capped at `take`. Mirrors {@link list}'s filter
   * semantics (search over sku/name, optional isActive/category) but returns the
   * whole result set in one shot for a CSV/Excel export rather than a page.
   */
  async listForExport(
    companyId: bigint,
    opts: { take: number; search?: string; isActive?: boolean; categoryId?: bigint },
    executor?: DbClient,
  ): Promise<ProductRow[]> {
    const where: Prisma.ProductWhereInput = { companyId, deletedAt: null };
    if (opts.isActive !== undefined) where.isActive = opts.isActive;
    if (opts.categoryId !== undefined) where.categoryId = opts.categoryId;
    if (opts.search) {
      where.OR = [
        { sku: { contains: opts.search, mode: 'insensitive' } },
        { name: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    return this.db(executor).product.findMany({
      where,
      orderBy: { sku: 'asc' },
      take: opts.take,
      select: SELECT,
    });
  }

  /** Update by internal id (caller has already resolved it within the company). */
  async update(id: bigint, data: ProductWriteData, executor: DbClient): Promise<ProductRow> {
    return executor.product.update({
      where: { id },
      data: {
        sku: data.sku,
        name: data.name,
        description: data.description,
        barcode: data.barcode,
        unit: data.unit,
        categoryId: data.categoryId,
        listPriceAmount: data.listPriceAmount,
        currency: data.currency,
        taxRateBp: data.taxRateBp,
        criticalStockThreshold: data.criticalStockThreshold,
        isActive: data.isActive,
      },
      select: SELECT,
    });
  }

  /** Soft delete: stamp deleted_at (the partial unique frees the SKU for reuse). */
  async softDelete(id: bigint, at: Date, executor: DbClient): Promise<void> {
    await executor.product.update({ where: { id }, data: { deletedAt: at } });
  }

  /** Whether a category exists and is not soft-deleted (categories are global). */
  async categoryExists(categoryId: bigint, executor?: DbClient): Promise<boolean> {
    const row = await this.db(executor).category.findFirst({
      where: { id: categoryId, deletedAt: null },
      select: { id: true },
    });
    return row !== null;
  }
}
