import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { WarehouseListView, WarehouseView } from '@b2b/contracts';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../common/auth/principal';
import type { RequestMeta } from '../../common/http/request-meta';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PrismaService } from '../../common/database/prisma.service';
import { WarehouseScopeService } from '../authorization/warehouse-scope.service';
import {
  WarehouseRepository,
  type WarehouseRow,
  type WarehouseWriteData,
} from './warehouse.repository';
import { toWarehouseView } from './warehouse-view';
import type { CreateWarehouseDto } from './dto/create-warehouse.dto';
import type { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import type { ListWarehousesQuery } from './dto/list-warehouses.query';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Warehouse master-data application service (TASK-012).
 *
 * Two orthogonal access controls guard every method:
 *   1. TENANT — the owning company is ALWAYS `actor.companyId`, the principal's
 *      REAL company resolved from PostgreSQL (never the body, never a JWT claim).
 *      Every read/write is filtered by it, so a forged `companyId` can neither
 *      read nor mutate another tenant's warehouses, and a cross-company id is a
 *      404 (entity hiding, API_CONVENTIONS §7b).
 *   2. WAREHOUSE SCOPE — beyond holding the route permission, the actor must be
 *      scoped to the specific warehouse for read/update/delete: an explicit
 *      `user_warehouse_scopes` grant OR the protected `warehouse:scope:all`
 *      (SECURITY_MODEL §3 / CLAUDE rule 12). No role name confers implicit scope.
 *      Decisions are resolved fresh from PostgreSQL by {@link WarehouseScopeService}.
 *      `POST` needs no scope (the warehouse does not exist yet) — `warehouse:create`
 *      alone suffices, and NO implicit scope is granted to the creator (an
 *      ambiguous auto-grant is deliberately avoided; SECURITY_MODEL §3).
 *
 * Mutations run in one transaction together with their business-audit row
 * (ADR-007), and delete is a soft delete (`deleted_at`) so the row survives and
 * its code becomes reusable within the company (the partial unique index).
 */
@Injectable()
export class WarehousesService {
  constructor(
    private readonly repo: WarehouseRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly scope: WarehouseScopeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    actor: AuthPrincipal,
    dto: CreateWarehouseDto,
    meta: RequestMeta,
  ): Promise<WarehouseView> {
    const data = this.toCreateData(dto);
    try {
      const created = await this.prisma.transaction(async (tx) => {
        const warehouse = await this.repo.create(actor.companyId, data, tx);
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.WAREHOUSE_CREATED,
          actor: this.actorSnapshot(actor),
          entityType: 'warehouse',
          entityId: warehouse.id,
          after: this.auditProjection(warehouse),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return warehouse;
      });
      return toWarehouseView(created);
    } catch (err) {
      throw this.mapWriteError(err, dto.code);
    }
  }

  async list(actor: AuthPrincipal, query: ListWarehousesQuery): Promise<WarehouseListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor);

    // Scope envelope (deny-by-default): an unresolved actor sees nothing; a global
    // actor sees every company warehouse; otherwise only the explicitly-scoped
    // ids. `warehouse:scope:all` never reaches another tenant — the company filter
    // is applied unconditionally by the repository.
    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) return emptyPage();
    const onlyIds = access.global ? undefined : access.scopedWarehouseIds;

    const rows = await this.repo.list(actor.companyId, {
      cursorId,
      take: limit + 1,
      search: query.search?.trim() || undefined,
      isActive: parseBool(query.isActive),
      onlyIds,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? encodeCursor(page[page.length - 1]!.id) : null;
    return { data: page.map(toWarehouseView), pageInfo: { nextCursor, hasNextPage } };
  }

  async getOne(actor: AuthPrincipal, publicId: string): Promise<WarehouseView> {
    const warehouse = await this.resolveOrThrow(actor.companyId, publicId);
    await this.assertScopeOrThrow(actor, warehouse, 'warehouse:read');
    return toWarehouseView(warehouse);
  }

  async update(
    actor: AuthPrincipal,
    publicId: string,
    dto: UpdateWarehouseDto,
    meta: RequestMeta,
  ): Promise<WarehouseView> {
    const existing = await this.resolveOrThrow(actor.companyId, publicId);
    await this.assertScopeOrThrow(actor, existing, 'warehouse:update');
    const data = this.toUpdateData(dto);

    try {
      const updated = await this.prisma.transaction(async (tx) => {
        const warehouse = await this.repo.update(existing.id, data, tx);
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.WAREHOUSE_UPDATED,
          actor: this.actorSnapshot(actor),
          entityType: 'warehouse',
          entityId: warehouse.id,
          before: this.auditProjection(existing),
          after: this.auditProjection(warehouse),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return warehouse;
      });
      return toWarehouseView(updated);
    } catch (err) {
      throw this.mapWriteError(err, dto.code ?? existing.code);
    }
  }

  async remove(actor: AuthPrincipal, publicId: string, meta: RequestMeta): Promise<void> {
    const existing = await this.resolveOrThrow(actor.companyId, publicId);
    await this.assertScopeOrThrow(actor, existing, 'warehouse:delete');
    const at = this.clock.now();
    await this.prisma.transaction(async (tx) => {
      await this.repo.softDelete(existing.id, at, tx);
      await this.audit.write(tx, {
        action: AUDIT_ACTIONS.WAREHOUSE_DELETED,
        actor: this.actorSnapshot(actor),
        entityType: 'warehouse',
        entityId: existing.id,
        before: this.auditProjection(existing),
        after: { deletedAt: at.toISOString() },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    });
  }

  // --- internals -----------------------------------------------------------

  /** Resolve an active warehouse in the actor's company or 404. A cross-company
   * (or soft-deleted/non-existent) id is therefore hidden behind a 404 —
   * object-level authz, §7b — BEFORE any scope check leaks its existence. */
  private async resolveOrThrow(companyId: bigint, publicId: string): Promise<WarehouseRow> {
    const warehouse = await this.repo.findActiveByPublicId(companyId, publicId);
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    return warehouse;
  }

  /**
   * The warehouse is already known to be an active row in the actor's OWN tenant
   * (resolveOrThrow). Re-resolve the scope decision fresh from PostgreSQL: the
   * actor must hold the route permission AND be scoped to this warehouse
   * (explicit grant or `warehouse:scope:all`). A same-tenant out-of-scope (or a
   * concurrently-revoked permission) is a 403 — never a silent allow.
   */
  private async assertScopeOrThrow(
    actor: AuthPrincipal,
    warehouse: WarehouseRow,
    permission: string,
  ): Promise<void> {
    const decision = await this.scope.canAccessWarehouseForPermission(
      actor.userId,
      warehouse.id,
      permission,
    );
    if (!decision.allowed) {
      throw new ForbiddenException('Out of warehouse scope');
    }
  }

  private toCreateData(dto: CreateWarehouseDto): WarehouseWriteData {
    return {
      code: dto.code,
      name: dto.name,
      addressLine1: dto.addressLine1 ?? null,
      addressLine2: dto.addressLine2 ?? null,
      city: dto.city ?? null,
      postalCode: dto.postalCode ?? null,
      country: normalizeCountry(dto.country),
      isActive: dto.isActive,
    };
  }

  /** Build a PATCH write object: a key is included ONLY when present in the body
   * (an explicit `null` clears a nullable field; `undefined`/absent leaves it). */
  private toUpdateData(dto: UpdateWarehouseDto): WarehouseWriteData {
    const data: WarehouseWriteData = {};
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.addressLine1 !== undefined) data.addressLine1 = dto.addressLine1;
    if (dto.addressLine2 !== undefined) data.addressLine2 = dto.addressLine2;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.postalCode !== undefined) data.postalCode = dto.postalCode;
    if (dto.country !== undefined) data.country = normalizeCountry(dto.country);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    return data;
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
  private auditProjection(w: WarehouseRow): Record<string, unknown> {
    return {
      code: w.code,
      name: w.name,
      addressLine1: w.addressLine1,
      addressLine2: w.addressLine2,
      city: w.city,
      postalCode: w.postalCode,
      country: w.country,
      isActive: w.isActive,
    };
  }

  /** Map a duplicate-code unique violation to 409; rethrow anything else. */
  private mapWriteError(err: unknown, code: string): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(
        `A warehouse with code "${code}" already exists in this company`,
      );
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

/** Normalise a 2-letter country to upper case (DB column is CHAR(2)); null/absent stays as-is. */
function normalizeCountry(country: string | null | undefined): string | null | undefined {
  if (country === undefined) return undefined;
  if (country === null) return null;
  return country.toUpperCase();
}

function emptyPage(): WarehouseListView {
  return { data: [], pageInfo: { nextCursor: null, hasNextPage: false } };
}

/** Opaque cursor = base64url of the last seen internal id. */
function encodeCursor(id: bigint): string {
  return Buffer.from(`w:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^w:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
