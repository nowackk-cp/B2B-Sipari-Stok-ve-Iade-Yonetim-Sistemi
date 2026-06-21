import { Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../../../common/auth/principal';
import { CLOCK, type Clock } from '../../../common/time/clock';
import { ProductRepository } from '../product.repository';
import { toCsv } from './product-csv';

/** Hard cap on export rows for this synchronous foundation (a streaming/async
 * export comes with the worker slice). Well above any realistic catalog here. */
const EXPORT_ROW_CAP = 50_000;

/** Columns mirror the IMPORT schema so an export can be edited and re-imported. */
const EXPORT_HEADER = [
  'sku',
  'name',
  'description',
  'currency',
  'listPriceAmount',
  'taxRateBp',
  'criticalStockThreshold',
  'isActive',
] as const;

export interface ProductExportFilters {
  search?: string;
  /** Tri-state: true/false filter, or undefined to use the export default. */
  isActive?: boolean;
  categoryId?: bigint;
}

export interface ProductExportFile {
  filename: string;
  contentType: string;
  body: string;
}

/**
 * Product catalog CSV export (Product Import/Export Foundation).
 *
 * Strictly company-scoped: only the actor's own tenant's products are ever
 * serialised — there is no cross-tenant leakage because the query is filtered by
 * `actor.companyId` (the PostgreSQL principal, never a claim). Soft-deleted
 * products are always excluded (mirrors the product list). The DEFAULT export is
 * ACTIVE products only; an explicit `isActive=false` exports the inactive ones.
 */
@Injectable()
export class ProductExportService {
  constructor(
    private readonly repo: ProductRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async export(actor: AuthPrincipal, filters: ProductExportFilters): Promise<ProductExportFile> {
    const rows = await this.repo.listForExport(actor.companyId, {
      take: EXPORT_ROW_CAP,
      search: filters.search,
      // Default to ACTIVE products when the caller does not pin isActive.
      isActive: filters.isActive ?? true,
      categoryId: filters.categoryId,
    });

    const body = toCsv(
      [...EXPORT_HEADER],
      rows.map((p) => [
        p.sku,
        p.name,
        p.description ?? '',
        p.currency,
        p.listPriceAmount.toString(),
        p.taxRateBp,
        p.criticalStockThreshold === null ? '' : p.criticalStockThreshold.toString(),
        p.isActive ? 'true' : 'false',
      ]),
    );

    const stamp = this.clock.now().toISOString().slice(0, 10).replace(/-/g, '');
    return {
      filename: `products-${stamp}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body,
    };
  }
}
