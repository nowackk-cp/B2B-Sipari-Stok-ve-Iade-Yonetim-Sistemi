import { ApiProperty } from '@nestjs/swagger';
import type {
  InvoiceItemView,
  InvoiceListView,
  InvoiceView,
  MoneyView,
  PageInfo,
} from '@b2b/contracts';

/**
 * Swagger RESPONSE models (Invoice/Billing Foundation).
 *
 * The controller's return types are `@b2b/contracts` INTERFACES, which carry no
 * runtime metadata, so generated OpenAPI response bodies would be empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each `implements`
 * its contract interface so the documented shape can never drift from the wire
 * shape. They are never instantiated — the service still returns plain objects
 * mapped by `toInvoiceView`, so the runtime response is unchanged.
 */
export class InvoiceMoneyResponse implements MoneyView {
  @ApiProperty({ example: '24000', description: 'Amount in minor units (BIGINT string).' })
  amount!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency code.' })
  currency!: string;
}

export class InvoiceItemResponse implements InvoiceItemView {
  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Public product id.' })
  productId!: string | null;

  @ApiProperty({ example: 'Widget', description: 'Line description (product-name snapshot).' })
  description!: string;

  @ApiProperty({ example: '2', description: 'Quantity invoiced (BIGINT string, positive).' })
  quantity!: string;

  @ApiProperty({ type: InvoiceMoneyResponse, description: 'Unit price (frozen from the order).' })
  unitPrice!: InvoiceMoneyResponse;

  @ApiProperty({ example: 2000, description: 'VAT rate in basis points (2000 = 20%).' })
  vatRate!: number;

  @ApiProperty({ type: InvoiceMoneyResponse, description: 'Line net = unitPrice × quantity.' })
  lineSubtotal!: InvoiceMoneyResponse;

  @ApiProperty({ type: InvoiceMoneyResponse, description: 'Line VAT.' })
  lineVat!: InvoiceMoneyResponse;

  @ApiProperty({ type: InvoiceMoneyResponse, description: 'Line total = net + VAT.' })
  lineTotal!: InvoiceMoneyResponse;
}

export class InvoiceResponse implements InvoiceView {
  @ApiProperty({ format: 'uuid', description: 'Public invoice id (UUID).' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'INV-2026-000001',
    description: 'Gapless human-facing invoice number.',
  })
  invoiceNo!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1',
    description: 'Numeric invoice number within the series (BIGINT string).',
  })
  invoiceNumber!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'INV', description: 'Series code.' })
  seriesCode!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 2026, description: 'Fiscal year.' })
  fiscalYear!: number | null;

  @ApiProperty({ example: 'ISSUED', description: 'Lifecycle status (ISSUED here).' })
  status!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Public order id.' })
  orderId!: string | null;

  @ApiProperty({ format: 'uuid', description: 'Public customer id.' })
  customerId!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Public warehouse id.',
  })
  warehouseId!: string | null;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency shared by every line.' })
  currency!: string;

  @ApiProperty({ type: InvoiceMoneyResponse, description: 'Σ line net.' })
  subtotal!: InvoiceMoneyResponse;

  @ApiProperty({ type: InvoiceMoneyResponse, description: 'Σ line VAT.' })
  vat!: InvoiceMoneyResponse;

  @ApiProperty({ type: InvoiceMoneyResponse, description: 'subtotal + vat.' })
  total!: InvoiceMoneyResponse;

  @ApiProperty({ type: [InvoiceItemResponse] })
  items!: InvoiceItemResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'When the invoice was issued (number allocated), or null.',
  })
  issuedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class InvoicePageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class InvoiceListResponse implements InvoiceListView {
  @ApiProperty({ type: [InvoiceResponse] })
  data!: InvoiceResponse[];

  @ApiProperty({ type: InvoicePageInfoResponse })
  pageInfo!: InvoicePageInfoResponse;
}
