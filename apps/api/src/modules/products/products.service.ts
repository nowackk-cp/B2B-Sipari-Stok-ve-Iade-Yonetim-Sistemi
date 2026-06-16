import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { ProductListView, ProductView } from '@b2b/contracts';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../common/auth/principal';
import type { RequestMeta } from '../../common/http/request-meta';
import { CLOCK, type Clock } from '../../common/time/clock';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import type { CreateProductDto } from './dto/create-product.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { ListProductsQuery } from './dto/list-products.query';
import { ProductRepository, type ProductRow, type ProductWriteData } from './product.repository';
import { toProductView } from './product-view';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Product catalog application service (TASK-011).
 *
 * Tenant isolation is the spine of every method: the owning company is ALWAYS
 * `actor.companyId` — the principal's REAL company resolved from PostgreSQL by
 * the auth guard, never the request body and never a JWT claim. A forged
 * `companyId` therefore cannot read or write another tenant's catalog. Mutations
 * run in one transaction together with their business-audit row (ADR-007), and
 * delete is a soft delete (`deleted_at`) so the row survives and its SKU becomes
 * reusable within the company (the partial unique index).
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly repo: ProductRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    actor: AuthPrincipal,
    dto: CreateProductDto,
    meta: RequestMeta,
  ): Promise<ProductView> {
    const data = this.toCreateData(dto);
    await this.assertCategory(dto.categoryId);

    try {
      const created = await this.prisma.transaction(async (tx) => {
        const product = await this.repo.create(actor.companyId, data, tx);
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.PRODUCT_CREATED,
          actor: this.actorSnapshot(actor),
          entityType: 'product',
          entityId: product.id,
          after: this.auditProjection(product),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return product;
      });
      return toProductView(created);
    } catch (err) {
      throw this.mapWriteError(err, dto.sku);
    }
  }

  async list(actor: AuthPrincipal, query: ListProductsQuery): Promise<ProductListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor);
    const rows = await this.repo.list(actor.companyId, {
      cursorId,
      take: limit + 1,
      search: query.search?.trim() || undefined,
      isActive: parseBool(query.isActive),
      categoryId: query.categoryId ? BigInt(query.categoryId) : undefined,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? encodeCursor(page[page.length - 1]!.id) : null;
    return { data: page.map(toProductView), pageInfo: { nextCursor, hasNextPage } };
  }

  async getOne(actor: AuthPrincipal, publicId: string): Promise<ProductView> {
    const product = await this.resolveOrThrow(actor.companyId, publicId);
    return toProductView(product);
  }

  async update(
    actor: AuthPrincipal,
    publicId: string,
    dto: UpdateProductDto,
    meta: RequestMeta,
  ): Promise<ProductView> {
    const existing = await this.resolveOrThrow(actor.companyId, publicId);
    if (dto.categoryId !== undefined && dto.categoryId !== null) {
      await this.assertCategory(dto.categoryId);
    }
    const data = this.toUpdateData(dto);

    try {
      const updated = await this.prisma.transaction(async (tx) => {
        const product = await this.repo.update(existing.id, data, tx);
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.PRODUCT_UPDATED,
          actor: this.actorSnapshot(actor),
          entityType: 'product',
          entityId: product.id,
          before: this.auditProjection(existing),
          after: this.auditProjection(product),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return product;
      });
      return toProductView(updated);
    } catch (err) {
      throw this.mapWriteError(err, dto.sku ?? existing.sku);
    }
  }

  async remove(actor: AuthPrincipal, publicId: string, meta: RequestMeta): Promise<void> {
    const existing = await this.resolveOrThrow(actor.companyId, publicId);
    const at = this.clock.now();
    await this.prisma.transaction(async (tx) => {
      await this.repo.softDelete(existing.id, at, tx);
      await this.audit.write(tx, {
        action: AUDIT_ACTIONS.PRODUCT_DELETED,
        actor: this.actorSnapshot(actor),
        entityType: 'product',
        entityId: existing.id,
        before: this.auditProjection(existing),
        after: { deletedAt: at.toISOString() },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    });
  }

  // --- internals -----------------------------------------------------------

  /** Resolve an active product in the actor's company or 404 (also hides
   * another tenant's product behind a 404 — object-level authz, §7b). */
  private async resolveOrThrow(companyId: bigint, publicId: string): Promise<ProductRow> {
    const product = await this.repo.findActiveByPublicId(companyId, publicId);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private toCreateData(dto: CreateProductDto): ProductWriteData {
    return {
      sku: dto.sku,
      name: dto.name,
      description: dto.description ?? null,
      barcode: dto.barcode ?? null,
      unit: dto.unit,
      categoryId: dto.categoryId != null ? BigInt(dto.categoryId) : null,
      listPriceAmount: dto.listPrice ? BigInt(dto.listPrice.amount) : undefined,
      currency: dto.listPrice ? dto.listPrice.currency : undefined,
      taxRateBp: dto.vatRate,
      criticalStockThreshold:
        dto.criticalStockThreshold != null ? BigInt(dto.criticalStockThreshold) : null,
      isActive: dto.isActive,
    };
  }

  /** Build a PATCH write object: a key is included ONLY when present in the body
   * (an explicit `null` clears a nullable field; `undefined`/absent leaves it). */
  private toUpdateData(dto: UpdateProductDto): ProductWriteData {
    const data: ProductWriteData = {};
    if (dto.sku !== undefined) data.sku = dto.sku;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.barcode !== undefined) data.barcode = dto.barcode;
    if (dto.unit !== undefined) data.unit = dto.unit;
    if (dto.categoryId !== undefined) {
      data.categoryId = dto.categoryId === null ? null : BigInt(dto.categoryId);
    }
    if (dto.vatRate !== undefined) data.taxRateBp = dto.vatRate;
    if (dto.listPrice !== undefined) {
      data.listPriceAmount = BigInt(dto.listPrice.amount);
      data.currency = dto.listPrice.currency;
    }
    if (dto.criticalStockThreshold !== undefined) {
      data.criticalStockThreshold =
        dto.criticalStockThreshold === null ? null : BigInt(dto.criticalStockThreshold);
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    return data;
  }

  private async assertCategory(categoryId: string | null | undefined): Promise<void> {
    if (categoryId == null) return;
    const exists = await this.repo.categoryExists(BigInt(categoryId));
    if (!exists) throw new UnprocessableEntityException('Category not found');
  }

  private actorSnapshot(actor: AuthPrincipal) {
    return {
      id: actor.userId,
      email: actor.email,
      name: actor.fullName,
      rolesSnapshot: actor.roles,
    };
  }

  /** Whitelisted domain projection for the audit before/after (no secrets). */
  private auditProjection(p: ProductRow): Record<string, unknown> {
    return {
      sku: p.sku,
      name: p.name,
      description: p.description,
      barcode: p.barcode,
      unit: p.unit,
      categoryId: p.categoryId === null ? null : p.categoryId.toString(),
      vatRate: p.taxRateBp,
      listPriceAmount: p.listPriceAmount.toString(),
      currency: p.currency,
      criticalStockThreshold:
        p.criticalStockThreshold === null ? null : p.criticalStockThreshold.toString(),
      isActive: p.isActive,
    };
  }

  /** Map a duplicate-SKU unique violation to 409; rethrow anything else. */
  private mapWriteError(err: unknown, sku: string): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(`A product with SKU "${sku}" already exists in this company`);
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      return new BadRequestException('Referenced category does not exist');
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true';
}

/** Opaque cursor = base64url of the last seen internal id. */
function encodeCursor(id: bigint): string {
  return Buffer.from(`p:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^p:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
