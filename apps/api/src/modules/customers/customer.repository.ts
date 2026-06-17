import { Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** Internal, fully-typed customer record. Never returned to clients directly —
 * the controller maps it to the whitelisted {@link CustomerView} contract. */
export interface CustomerRow {
  id: bigint;
  publicId: string;
  companyId: bigint;
  code: string;
  name: string;
  type: string;
  taxNumber: string | null;
  email: string | null;
  phone: string | null;
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
  type: true,
  taxNumber: true,
  email: true,
  phone: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

/** Mutable customer fields a create/update may set (already validated/normalised). */
export interface CustomerWriteData {
  code?: string;
  name?: string;
  type?: string;
  taxNumber?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface ListCustomersOptions {
  /** Exclusive lower-bound id (rows with id > cursorId), for cursor pagination. */
  cursorId?: bigint;
  /** Number of rows to fetch (callers pass limit+1 to detect a next page). */
  take: number;
  /** Case-insensitive substring over code/name/email/taxNumber. */
  search?: string;
  type?: string;
}

/**
 * Data access for the `customers` table (MODULE_BOUNDARIES §2). Every method
 * takes an explicit executor so it composes inside a caller's transaction, and
 * EVERY query is scoped to a `companyId` — tenant isolation is enforced here as
 * well as by the DB composite key, so one company can never read or mutate
 * another's customers. Reads exclude soft-deleted rows.
 */
@Injectable()
export class CustomerRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  async create(
    companyId: bigint,
    data: CustomerWriteData,
    executor: DbClient,
  ): Promise<CustomerRow> {
    return executor.customer.create({
      data: {
        companyId,
        code: data.code as string,
        name: data.name as string,
        type: data.type,
        taxNumber: data.taxNumber ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
      },
      select: SELECT,
    });
  }

  /** Find an ACTIVE (not soft-deleted) customer by public id WITHIN a company. */
  async findActiveByPublicId(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<CustomerRow | null> {
    return this.db(executor).customer.findFirst({
      where: { publicId, companyId, deletedAt: null },
      select: SELECT,
    });
  }

  /** Page of active customers for a company (ordered by id asc; cursor-friendly). */
  async list(
    companyId: bigint,
    opts: ListCustomersOptions,
    executor?: DbClient,
  ): Promise<CustomerRow[]> {
    const where: Prisma.CustomerWhereInput = { companyId, deletedAt: null };
    if (opts.cursorId !== undefined) where.id = { gt: opts.cursorId };
    if (opts.type !== undefined) where.type = opts.type;
    if (opts.search) {
      where.OR = [
        { code: { contains: opts.search, mode: 'insensitive' } },
        { name: { contains: opts.search, mode: 'insensitive' } },
        { email: { contains: opts.search, mode: 'insensitive' } },
        { taxNumber: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    return this.db(executor).customer.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
      select: SELECT,
    });
  }

  /** Update by internal id (caller has already resolved it within the company). */
  async update(id: bigint, data: CustomerWriteData, executor: DbClient): Promise<CustomerRow> {
    return executor.customer.update({
      where: { id },
      data: {
        code: data.code,
        name: data.name,
        type: data.type,
        taxNumber: data.taxNumber,
        email: data.email,
        phone: data.phone,
      },
      select: SELECT,
    });
  }

  /** Soft delete: stamp deleted_at (the partial unique frees the code for reuse). */
  async softDelete(id: bigint, at: Date, executor: DbClient): Promise<void> {
    await executor.customer.update({ where: { id }, data: { deletedAt: at } });
  }
}
