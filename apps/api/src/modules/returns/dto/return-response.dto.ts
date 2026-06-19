import { ApiProperty } from '@nestjs/swagger';
import type { PageInfo, ReturnItemView, ReturnListView, ReturnView } from '@b2b/contracts';

/**
 * Swagger RESPONSE models (Return/Refund Foundation).
 *
 * The controller's return types are `@b2b/contracts` INTERFACES, which carry no
 * runtime metadata, so generated OpenAPI response bodies would be empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each `implements`
 * its contract interface so the documented shape can never drift from the wire
 * shape. They are never instantiated — the service still returns plain objects
 * mapped by `toReturnView`, so the runtime response is unchanged.
 */
export class ReturnItemResponse implements ReturnItemView {
  @ApiProperty({ format: 'uuid', description: 'Public product id.' })
  productId!: string;

  @ApiProperty({ example: '1', description: 'Quantity returned (BIGINT string, positive).' })
  quantity!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Optional per-line reason.' })
  reason!: string | null;
}

export class ReturnResponse implements ReturnView {
  @ApiProperty({ format: 'uuid', description: 'Public return id (UUID).' })
  id!: string;

  @ApiProperty({ example: 'RET-20260618-AB12CD34EF', description: 'Human-facing return number.' })
  returnNo!: string;

  @ApiProperty({ example: 'DRAFT', description: 'Lifecycle status (DRAFT or APPROVED).' })
  status!: string;

  @ApiProperty({ format: 'uuid', description: 'Public order id.' })
  orderId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public customer id.' })
  customerId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public warehouse id (goods return here).' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Public invoice id.' })
  invoiceId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Optional return-level reason.' })
  reason!: string | null;

  @ApiProperty({ type: [ReturnItemResponse] })
  items!: ReturnItemResponse[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'When the return was approved (restocked), or null while DRAFT.',
  })
  approvedAt!: string | null;
}

export class ReturnPageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class ReturnListResponse implements ReturnListView {
  @ApiProperty({ type: [ReturnResponse] })
  data!: ReturnResponse[];

  @ApiProperty({ type: ReturnPageInfoResponse })
  pageInfo!: ReturnPageInfoResponse;
}
