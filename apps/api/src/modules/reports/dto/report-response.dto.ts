import { ApiProperty } from '@nestjs/swagger';
import type {
  DashboardSummaryView,
  InventoryReportRowView,
  InventoryReportView,
  MoneyView,
  PageInfo,
  ReturnsReportView,
  SalesReportRowView,
  SalesReportView,
} from '@b2b/contracts';

/**
 * Swagger RESPONSE models (Dashboard / Reports Backend Foundation).
 *
 * The controllers' return types are `@b2b/contracts` INTERFACES, which carry no
 * runtime metadata, so generated OpenAPI response bodies would be empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each
 * `implements` its contract interface so the documented shape can never drift
 * from the wire shape. They are never instantiated — the services return plain
 * objects, so the runtime response is unchanged.
 */
export class ReportMoneyResponse implements MoneyView {
  @ApiProperty({ example: '24000', description: 'Amount in minor units (BIGINT string).' })
  amount!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency code.' })
  currency!: string;
}

export class DashboardSummaryResponse implements DashboardSummaryView {
  @ApiProperty({ example: 42 })
  totalProducts!: number;

  @ApiProperty({ example: 40 })
  activeProducts!: number;

  @ApiProperty({ example: 12 })
  totalCustomers!: number;

  @ApiProperty({ example: 3 })
  lowStockProducts!: number;

  @ApiProperty({ example: 5 })
  draftOrders!: number;

  @ApiProperty({ example: 2 })
  approvedOrders!: number;

  @ApiProperty({ example: 7 })
  shippedOrders!: number;

  @ApiProperty({ example: 6 })
  issuedInvoices!: number;

  @ApiProperty({ example: 1 })
  requestedReturns!: number;

  @ApiProperty({ example: 1 })
  approvedReturns!: number;

  @ApiProperty({ type: [ReportMoneyResponse], description: 'Today’s sales by currency.' })
  todaySalesAmount!: ReportMoneyResponse[];

  @ApiProperty({ type: [ReportMoneyResponse], description: 'This month’s sales by currency.' })
  monthSalesAmount!: ReportMoneyResponse[];
}

export class SalesReportRowResponse implements SalesReportRowView {
  @ApiProperty({ example: '2026-06-01', description: 'Bucket period (YYYY-MM-DD or YYYY-MM).' })
  period!: string;

  @ApiProperty({ example: 4 })
  invoiceCount!: number;

  @ApiProperty({ example: '80000', description: 'Σ line net (minor-unit BIGINT string).' })
  subtotalAmount!: string;

  @ApiProperty({ example: '16000', description: 'Σ VAT (minor-unit BIGINT string).' })
  vatAmount!: string;

  @ApiProperty({ example: '96000', description: 'Σ grand total (minor-unit BIGINT string).' })
  totalAmount!: string;

  @ApiProperty({ example: 'TRY' })
  currency!: string;
}

export class SalesReportResponse implements SalesReportView {
  @ApiProperty({ enum: ['day', 'month'] })
  groupBy!: 'day' | 'month';

  @ApiProperty({ format: 'date-time' })
  dateFrom!: string;

  @ApiProperty({ format: 'date-time' })
  dateTo!: string;

  @ApiProperty({ type: [SalesReportRowResponse] })
  rows!: SalesReportRowResponse[];
}

export class InventoryReportRowResponse implements InventoryReportRowView {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ example: 'SKU-1' })
  sku!: string;

  @ApiProperty({ example: 'Widget' })
  name!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ example: '100', description: 'On-hand quantity (BIGINT string).' })
  onHand!: string;

  @ApiProperty({ example: '10', description: 'Reserved quantity (BIGINT string).' })
  reserved!: string;

  @ApiProperty({ example: '90', description: 'available = onHand − reserved (BIGINT string).' })
  available!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '20',
    description: 'Critical-stock threshold (BIGINT string), or null.',
  })
  criticalStockThreshold!: string | null;

  @ApiProperty({ example: false })
  isLowStock!: boolean;
}

export class ReportPageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class InventoryReportResponse implements InventoryReportView {
  @ApiProperty({ type: [InventoryReportRowResponse] })
  data!: InventoryReportRowResponse[];

  @ApiProperty({ type: ReportPageInfoResponse })
  pageInfo!: ReportPageInfoResponse;
}

export class ReturnsReportResponse implements ReturnsReportView {
  @ApiProperty({ example: 8 })
  returnCount!: number;

  @ApiProperty({ example: 3 })
  requestedCount!: number;

  @ApiProperty({ example: 4 })
  approvedCount!: number;

  @ApiProperty({ example: '15', description: 'Σ returned line quantities (BIGINT string).' })
  totalReturnedQuantity!: string;

  @ApiProperty({ example: 2 })
  creditNoteCount!: number;

  @ApiProperty({ type: [ReportMoneyResponse], description: 'Credit-note totals by currency.' })
  creditNoteTotalAmount!: ReportMoneyResponse[];
}
