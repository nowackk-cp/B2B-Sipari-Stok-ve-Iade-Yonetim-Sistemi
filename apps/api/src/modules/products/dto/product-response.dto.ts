import { ApiProperty } from '@nestjs/swagger';
import type { MoneyView, PageInfo, ProductListView, ProductView } from '@b2b/contracts';

/**
 * Swagger RESPONSE models (TASK-011 / PRODUCT-CATALOG review BLOCKER 2).
 *
 * The controller's return types are the `@b2b/contracts` INTERFACES, which carry
 * no runtime metadata, so generated OpenAPI response bodies were empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each `implements`
 * its contract interface so the documented shape can never drift from the wire
 * shape (a field rename/removal breaks the build). They are never instantiated —
 * the service still returns plain objects mapped by `toProductView`, so the
 * runtime response is unchanged.
 */
export class MoneyResponse implements MoneyView {
  @ApiProperty({ example: '12345', description: 'Amount in minor units (string).' })
  amount!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency code.' })
  currency!: string;
}

export class ProductResponse implements ProductView {
  @ApiProperty({ format: 'uuid', description: 'Public product id (UUID).' })
  id!: string;

  @ApiProperty({ example: 'SKU-001' })
  sku!: string;

  @ApiProperty({ example: 'Widget' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '8690000000017' })
  barcode!: string | null;

  @ApiProperty({ example: 'EACH' })
  unit!: string;

  @ApiProperty({ type: String, nullable: true, example: '12' })
  categoryId!: string | null;

  @ApiProperty({ example: 2000, description: 'VAT rate in basis points (2000 = 20%).' })
  vatRate!: number;

  @ApiProperty({ type: MoneyResponse })
  listPrice!: MoneyResponse;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '10' })
  criticalStockThreshold!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class PageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class ProductListResponse implements ProductListView {
  @ApiProperty({ type: [ProductResponse] })
  data!: ProductResponse[];

  @ApiProperty({ type: PageInfoResponse })
  pageInfo!: PageInfoResponse;
}
