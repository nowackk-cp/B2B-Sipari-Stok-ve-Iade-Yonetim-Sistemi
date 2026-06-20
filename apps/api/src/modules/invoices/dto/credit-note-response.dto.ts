import { ApiProperty } from '@nestjs/swagger';
import type {
  CreditNoteItemView,
  CreditNoteListView,
  CreditNoteView,
  MoneyView,
  PageInfo,
} from '@b2b/contracts';

/**
 * Swagger RESPONSE models (Return Invoice / Credit Note Foundation).
 *
 * The controller's return types are `@b2b/contracts` INTERFACES, which carry no
 * runtime metadata, so generated OpenAPI response bodies would be empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each `implements`
 * its contract interface so the documented shape can never drift from the wire
 * shape. They are never instantiated — the service still returns plain objects
 * mapped by `toCreditNoteView`, so the runtime response is unchanged.
 */
export class CreditNoteMoneyResponse implements MoneyView {
  @ApiProperty({ example: '12000', description: 'Amount in minor units (BIGINT string).' })
  amount!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency code.' })
  currency!: string;
}

export class CreditNoteItemResponse implements CreditNoteItemView {
  @ApiProperty({ format: 'uuid', description: 'Public product id.' })
  productId!: string;

  @ApiProperty({ example: 'Widget', description: 'Line description (product-name snapshot).' })
  description!: string;

  @ApiProperty({ example: '1', description: 'Quantity credited (BIGINT string, positive).' })
  quantity!: string;

  @ApiProperty({
    type: CreditNoteMoneyResponse,
    description: 'Unit price (frozen from the original order/invoice line).',
  })
  unitPrice!: CreditNoteMoneyResponse;

  @ApiProperty({ example: 2000, description: 'VAT rate in basis points (2000 = 20%).' })
  vatRate!: number;

  @ApiProperty({ type: CreditNoteMoneyResponse, description: 'Line net = unitPrice × quantity.' })
  lineSubtotal!: CreditNoteMoneyResponse;

  @ApiProperty({ type: CreditNoteMoneyResponse, description: 'Line VAT.' })
  lineVat!: CreditNoteMoneyResponse;

  @ApiProperty({ type: CreditNoteMoneyResponse, description: 'Line total = net + VAT.' })
  lineTotal!: CreditNoteMoneyResponse;
}

export class CreditNoteResponse implements CreditNoteView {
  @ApiProperty({ format: 'uuid', description: 'Public credit note id (UUID).' })
  id!: string;

  @ApiProperty({ example: 'CRN-2026-000001', description: 'Gapless credit note number.' })
  creditNoteNo!: string;

  @ApiProperty({ example: '1', description: 'Numeric number within the series (BIGINT string).' })
  creditNoteNumber!: string;

  @ApiProperty({ example: 'CRN', description: 'Series code.' })
  seriesCode!: string;

  @ApiProperty({ example: 2026, description: 'Fiscal year.' })
  fiscalYear!: number;

  @ApiProperty({ example: 'ISSUED', description: 'Lifecycle status (ISSUED here).' })
  status!: string;

  @ApiProperty({ format: 'uuid', description: 'Public source return id.' })
  returnId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public source order id.' })
  orderId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public original invoice id.' })
  originalInvoiceId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public customer id.' })
  customerId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public warehouse id.' })
  warehouseId!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency shared by every line.' })
  currency!: string;

  @ApiProperty({ type: CreditNoteMoneyResponse, description: 'Σ line net.' })
  subtotal!: CreditNoteMoneyResponse;

  @ApiProperty({ type: CreditNoteMoneyResponse, description: 'Σ line VAT.' })
  vat!: CreditNoteMoneyResponse;

  @ApiProperty({ type: CreditNoteMoneyResponse, description: 'subtotal + vat.' })
  total!: CreditNoteMoneyResponse;

  @ApiProperty({ type: [CreditNoteItemResponse] })
  items!: CreditNoteItemResponse[];

  @ApiProperty({ format: 'date-time', description: 'When the credit note was issued.' })
  issuedAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class CreditNotePageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class CreditNoteListResponse implements CreditNoteListView {
  @ApiProperty({ type: [CreditNoteResponse] })
  data!: CreditNoteResponse[];

  @ApiProperty({ type: CreditNotePageInfoResponse })
  pageInfo!: CreditNotePageInfoResponse;
}
