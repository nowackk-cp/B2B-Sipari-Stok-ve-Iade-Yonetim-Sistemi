import { ApiProperty } from '@nestjs/swagger';
import type {
  PageInfo,
  StockAdjustmentDirection,
  StockBalanceListView,
  StockBalanceView,
  StockMovementListView,
  StockMovementView,
} from '@b2b/contracts';

/**
 * Swagger RESPONSE models (Stock Ledger Foundation).
 *
 * The controller's return types are `@b2b/contracts` INTERFACES, which carry no
 * runtime metadata, so generated OpenAPI response bodies would be empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each
 * `implements` its contract interface so the documented shape can never drift
 * from the wire shape. They are never instantiated — the service still returns
 * plain objects mapped by the view functions.
 */
export class StockBalanceResponse implements StockBalanceView {
  @ApiProperty({ format: 'uuid', description: 'Public warehouse id.' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public product id.' })
  productId!: string;

  @ApiProperty({ example: 'SKU-001' })
  sku!: string;

  @ApiProperty({ example: 'Widget' })
  name!: string;

  @ApiProperty({ example: '120', description: 'On-hand quantity (BIGINT string).' })
  quantity!: string;

  @ApiProperty({ example: '120', description: 'Available = on_hand − reserved (BIGINT string).' })
  availableQuantity!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class StockMovementResponse implements StockMovementView {
  @ApiProperty({ format: 'uuid', description: 'Public warehouse id.' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public product id.' })
  productId!: string;

  @ApiProperty({ example: 'SKU-001' })
  sku!: string;

  @ApiProperty({ example: 'Widget' })
  name!: string;

  @ApiProperty({ example: 'ADJUSTMENT', description: 'Ledger change type.' })
  type!: string;

  @ApiProperty({ enum: ['INCREASE', 'DECREASE'] })
  direction!: StockAdjustmentDirection;

  @ApiProperty({ example: '10', description: 'Absolute magnitude (BIGINT string, positive).' })
  quantity!: string;

  @ApiProperty({ example: '110', description: 'On-hand before the movement (BIGINT string).' })
  balanceBefore!: string;

  @ApiProperty({ example: '120', description: 'On-hand after the movement (BIGINT string).' })
  balanceAfter!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Initial stock' })
  reason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class StockPageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class StockBalanceListResponse implements StockBalanceListView {
  @ApiProperty({ type: [StockBalanceResponse] })
  data!: StockBalanceResponse[];

  @ApiProperty({ type: StockPageInfoResponse })
  pageInfo!: StockPageInfoResponse;
}

export class StockMovementListResponse implements StockMovementListView {
  @ApiProperty({ type: [StockMovementResponse] })
  data!: StockMovementResponse[];

  @ApiProperty({ type: StockPageInfoResponse })
  pageInfo!: StockPageInfoResponse;
}
