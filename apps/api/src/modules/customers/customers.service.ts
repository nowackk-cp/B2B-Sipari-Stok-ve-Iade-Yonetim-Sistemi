import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { CustomerListView, CustomerView } from '@b2b/contracts';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../common/auth/principal';
import type { RequestMeta } from '../../common/http/request-meta';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PrismaService } from '../../common/database/prisma.service';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { UpdateCustomerDto } from './dto/update-customer.dto';
import type { ListCustomersQuery } from './dto/list-customers.query';
import {
  CustomerRepository,
  type CustomerRow,
  type CustomerWriteData,
} from './customer.repository';
import { toCustomerView } from './customer-view';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Customer master-data application service (Customer Management Foundation).
 *
 * Tenant isolation is the spine of every method: the owning company is ALWAYS
 * `actor.companyId` — the principal's REAL company resolved from PostgreSQL by
 * the auth guard, never the request body and never a JWT claim. A forged
 * `companyId` therefore cannot read or write another tenant's customers, and a
 * cross-company get/update/delete resolves to 404 (existence hiding, §7b).
 * Mutations run in one transaction together with their business-audit row
 * (ADR-007), and delete is a soft delete (`deleted_at`) so the row survives and
 * its code becomes reusable within the company (the partial unique index).
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly repo: CustomerRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    actor: AuthPrincipal,
    dto: CreateCustomerDto,
    meta: RequestMeta,
  ): Promise<CustomerView> {
    const data = this.toCreateData(dto);

    try {
      const created = await this.prisma.transaction(async (tx) => {
        const customer = await this.repo.create(actor.companyId, data, tx);
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.CUSTOMER_CREATED,
          actor: this.actorSnapshot(actor),
          entityType: 'customer',
          entityId: customer.id,
          after: this.auditProjection(customer),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return customer;
      });
      return toCustomerView(created);
    } catch (err) {
      throw this.mapWriteError(err, dto.code);
    }
  }

  async list(actor: AuthPrincipal, query: ListCustomersQuery): Promise<CustomerListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor);
    const rows = await this.repo.list(actor.companyId, {
      cursorId,
      take: limit + 1,
      search: query.search?.trim() || undefined,
      type: query.type,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? encodeCursor(page[page.length - 1]!.id) : null;
    return { data: page.map(toCustomerView), pageInfo: { nextCursor, hasNextPage } };
  }

  async getOne(actor: AuthPrincipal, publicId: string): Promise<CustomerView> {
    const customer = await this.resolveOrThrow(actor.companyId, publicId);
    return toCustomerView(customer);
  }

  async update(
    actor: AuthPrincipal,
    publicId: string,
    dto: UpdateCustomerDto,
    meta: RequestMeta,
  ): Promise<CustomerView> {
    const existing = await this.resolveOrThrow(actor.companyId, publicId);
    const data = this.toUpdateData(dto);

    try {
      const updated = await this.prisma.transaction(async (tx) => {
        const customer = await this.repo.update(existing.id, data, tx);
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
          actor: this.actorSnapshot(actor),
          entityType: 'customer',
          entityId: customer.id,
          before: this.auditProjection(existing),
          after: this.auditProjection(customer),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return customer;
      });
      return toCustomerView(updated);
    } catch (err) {
      throw this.mapWriteError(err, dto.code ?? existing.code);
    }
  }

  async remove(actor: AuthPrincipal, publicId: string, meta: RequestMeta): Promise<void> {
    const existing = await this.resolveOrThrow(actor.companyId, publicId);
    const at = this.clock.now();
    await this.prisma.transaction(async (tx) => {
      await this.repo.softDelete(existing.id, at, tx);
      await this.audit.write(tx, {
        action: AUDIT_ACTIONS.CUSTOMER_DELETED,
        actor: this.actorSnapshot(actor),
        entityType: 'customer',
        entityId: existing.id,
        before: this.auditProjection(existing),
        after: { deletedAt: at.toISOString() },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    });
  }

  // --- internals -----------------------------------------------------------

  /** Resolve an active customer in the actor's company or 404 (also hides
   * another tenant's customer behind a 404 — object-level authz, §7b). */
  private async resolveOrThrow(companyId: bigint, publicId: string): Promise<CustomerRow> {
    const customer = await this.repo.findActiveByPublicId(companyId, publicId);
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  private toCreateData(dto: CreateCustomerDto): CustomerWriteData {
    return {
      code: dto.code,
      name: dto.name,
      type: dto.type,
      taxNumber: dto.taxNumber ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
    };
  }

  /** Build a PATCH write object: a key is included ONLY when present in the body
   * (an explicit `null` clears a nullable field; `undefined`/absent leaves it). */
  private toUpdateData(dto: UpdateCustomerDto): CustomerWriteData {
    const data: CustomerWriteData = {};
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.taxNumber !== undefined) data.taxNumber = dto.taxNumber;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
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
  private auditProjection(c: CustomerRow): Record<string, unknown> {
    return {
      code: c.code,
      name: c.name,
      type: c.type,
      taxNumber: c.taxNumber,
      email: c.email,
      phone: c.phone,
    };
  }

  /** Map a duplicate-code unique violation to 409; rethrow anything else. */
  private mapWriteError(err: unknown, code: string): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(`A customer with code "${code}" already exists in this company`);
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      return new BadRequestException('Referenced company does not exist');
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

/** Opaque cursor = base64url of the last seen internal id. */
function encodeCursor(id: bigint): string {
  return Buffer.from(`c:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^c:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
