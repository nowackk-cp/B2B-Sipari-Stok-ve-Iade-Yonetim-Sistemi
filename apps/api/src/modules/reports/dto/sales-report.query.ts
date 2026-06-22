import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

/** Sales-report grouping granularity. */
export const SALES_GROUP_BY = ['day', 'month'] as const;

/**
 * Query for the gross-sales report (`GET /reports/sales`, API_CONVENTIONS §4).
 *
 * `dateFrom`/`dateTo` are REQUIRED ISO-8601 dates (UTC day granularity); an
 * invalid/unparseable value is a 400. `warehouseId` is an optional public-id
 * filter intersected with the caller's warehouse scope (it can never widen
 * access). `groupBy` defaults to `day`. Unknown query keys are rejected by the
 * strict pipe.
 */
export class SalesReportQuery {
  @ApiProperty({
    format: 'date',
    example: '2026-06-01',
    description: 'Inclusive range start (UTC).',
  })
  @IsDateString()
  dateFrom!: string;

  @ApiProperty({ format: 'date', example: '2026-06-30', description: 'Inclusive range end (UTC).' })
  @IsDateString()
  dateTo!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter to a single warehouse (public id).' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({ enum: SALES_GROUP_BY, default: 'day', description: 'Bucket granularity.' })
  @IsOptional()
  @IsIn(SALES_GROUP_BY)
  groupBy?: (typeof SALES_GROUP_BY)[number];
}
