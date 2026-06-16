import { Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** Internal, fully-typed warehouse record. Never returned to clients directly —
 * the service maps it to the whitelisted {@link WarehouseView} contract. */
export interface WarehouseRow {
  id: bigint;
  publicId: string;
  companyId: bigint;
  code: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const SELECT = {
  id: true,
  publicId: true,
  companyId: true,
  code: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  postalCode: true,
  country: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

/** Mutable warehouse fields a create/update may set (already validated/normalised). */
export interface WarehouseWriteData {
  code?: string;
  name?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  isActive?: boolean;
}

export interface ListWarehousesOptions {
  /** Exclusive lower-bound id (rows with id > cursorId), for cursor pagination. */
  cursorId?: bigint;
  /** Number of rows to fetch (callers pass limit+1 to detect a next page). */
  take: number;
  /** Case-insensitive substring over code/name. */
  search?: string;
  isActive?: boolean;
  /**
   * Restrict the page to these warehouse ids (the actor's explicit warehouse
   * scope). When `undefined` no id restriction is applied (the actor holds
   * global `warehouse:scope:all`); an EMPTY set means "no accessible warehouse"
   * and yields an empty page.
   */
  onlyIds?: ReadonlySet<bigint>;
}

/**
 * Data access for the `warehouses` table (MODULE_BOUNDARIES §2). Every method
 * takes an explicit executor so it composes inside a caller's transaction, and
 * EVERY query is scoped to a `companyId` — tenant isolation is enforced here as
 * well as by the DB composite key, so one company can never read or mutate
 * another's warehouses. Reads exclude soft-deleted rows.
 */
@Injectable()
export class WarehouseRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  async create(
    companyId: bigint,
    data: WarehouseWriteData,
    executor: DbClient,
  ): Promise<WarehouseRow> {
    return executor.warehouse.create({
      data: {
        companyId,
        code: data.code as string,
        name: data.name as string,
        addressLine1: data.addressLine1 ?? null,
        addressLine2: data.addressLine2 ?? null,
        city: data.city ?? null,
        postalCode: data.postalCode ?? null,
        country: data.country ?? null,
        isActive: data.isActive,
      },
      select: SELECT,
    });
  }

  /** Find an ACTIVE (not soft-deleted) warehouse by public id WITHIN a company. */
  async findActiveByPublicId(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<WarehouseRow | null> {
    return this.db(executor).warehouse.findFirst({
      where: { publicId, companyId, deletedAt: null },
      select: SELECT,
    });
  }

  /** Page of non-deleted warehouses for a company (ordered by id asc; cursor-friendly). */
  async list(
    companyId: bigint,
    opts: ListWarehousesOptions,
    executor?: DbClient,
  ): Promise<WarehouseRow[]> {
    const where: Prisma.WarehouseWhereInput = { companyId, deletedAt: null };
    const idFilter: Prisma.BigIntFilter = {};
    if (opts.cursorId !== undefined) idFilter.gt = opts.cursorId;
    if (opts.onlyIds !== undefined) {
      // An explicit (possibly empty) scope set: restrict to those ids. An empty
      // set yields `id IN ()` → no rows, the correct "no accessible warehouse".
      idFilter.in = [...opts.onlyIds];
    }
    if (Object.keys(idFilter).length > 0) where.id = idFilter;
    if (opts.isActive !== undefined) where.isActive = opts.isActive;
    if (opts.search) {
      where.OR = [
        { code: { contains: opts.search, mode: 'insensitive' } },
        { name: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    return this.db(executor).warehouse.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
      select: SELECT,
    });
  }

  /** Update by internal id (caller has already resolved it within the company). */
  async update(id: bigint, data: WarehouseWriteData, executor: DbClient): Promise<WarehouseRow> {
    return executor.warehouse.update({
      where: { id },
      data: {
        code: data.code,
        name: data.name,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        city: data.city,
        postalCode: data.postalCode,
        country: data.country,
        isActive: data.isActive,
      },
      select: SELECT,
    });
  }

  /** Soft delete: stamp deleted_at (the partial unique frees the code for reuse). */
  async softDelete(id: bigint, at: Date, executor: DbClient): Promise<void> {
    await executor.warehouse.update({ where: { id }, data: { deletedAt: at } });
  }
}
