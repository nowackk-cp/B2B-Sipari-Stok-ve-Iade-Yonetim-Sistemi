import { ApiProperty } from '@nestjs/swagger';
import type { MoneyView, OrderItemView, OrderListView, OrderView, PageInfo } from '@b2b/contracts';

/**
 * Swagger RESPONSE models (Order Draft Foundation).
 *
 * The controller's return types are `@b2b/contracts` INTERFACES, which carry no
 * runtime metadata, so generated OpenAPI response bodies would be empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each `implements`
 * its contract interface so the documented shape can never drift from the wire
 * shape. They are never instantiated — the service still returns plain objects
 * mapped by `toOrderView`, so the runtime response is unchanged.
 */
export class MoneyResponse implements MoneyView {
  @ApiProperty({ example: '20000', description: 'Amount in minor units (BIGINT string).' })
  amount!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency code.' })
  currency!: string;
}

export class OrderItemResponse implements OrderItemView {
  @ApiProperty({ format: 'uuid', description: 'Public product id.' })
  productId!: string;

  @ApiProperty({ example: 'SKU-001' })
  sku!: string;

  @ApiProperty({ example: 'Widget' })
  name!: string;

  @ApiProperty({ example: '2', description: 'Quantity ordered (BIGINT string, positive).' })
  quantity!: string;

  @ApiProperty({
    type: MoneyResponse,
    description: 'Unit price (server-derived from the product).',
  })
  unitPrice!: MoneyResponse;

  @ApiProperty({ example: 2000, description: 'VAT rate in basis points (2000 = 20%).' })
  vatRate!: number;

  @ApiProperty({ type: MoneyResponse, description: 'Line net = unitPrice × quantity.' })
  lineSubtotal!: MoneyResponse;

  @ApiProperty({ type: MoneyResponse, description: 'Line VAT = floor(net × vatRate / 10000).' })
  lineVat!: MoneyResponse;

  @ApiProperty({ type: MoneyResponse, description: 'Line total = net + VAT.' })
  lineTotal!: MoneyResponse;
}

export class OrderResponse implements OrderView {
  @ApiProperty({ format: 'uuid', description: 'Public order id (UUID).' })
  id!: string;

  @ApiProperty({ example: 'ORD-20260617-1A2B3C4D5E', description: 'Human-facing order number.' })
  orderNo!: string;

  @ApiProperty({ format: 'uuid', description: 'Public customer id.' })
  customerId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public source warehouse id.' })
  warehouseId!: string;

  @ApiProperty({ example: 'DRAFT', description: 'Lifecycle status (DRAFT or CANCELLED here).' })
  status!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency shared by every line.' })
  currency!: string;

  @ApiProperty({ type: MoneyResponse, description: 'Σ line net.' })
  subtotal!: MoneyResponse;

  @ApiProperty({ type: MoneyResponse, description: 'Σ line VAT.' })
  vat!: MoneyResponse;

  @ApiProperty({ type: MoneyResponse, description: 'subtotal + vat.' })
  total!: MoneyResponse;

  @ApiProperty({ type: String, nullable: true, example: 'Deliver before noon.' })
  note!: string | null;

  @ApiProperty({ type: [OrderItemResponse] })
  items!: OrderItemResponse[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  cancelledAt!: string | null;
}

export class OrderPageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class OrderListResponse implements OrderListView {
  @ApiProperty({ type: [OrderResponse] })
  data!: OrderResponse[];

  @ApiProperty({ type: OrderPageInfoResponse })
  pageInfo!: OrderPageInfoResponse;
}
