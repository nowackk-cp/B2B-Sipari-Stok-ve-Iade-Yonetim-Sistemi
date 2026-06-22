import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

/** Return statuses a report query may filter by. */
export const RETURN_STATUS_FILTERS = [
  'DRAFT',
  'APPROVED',
  'RECEIVED',
  'REJECTED',
  'COMPLETED',
] as const;

/**
 * Query for the returns report (`GET /reports/returns`, API_CONVENTIONS §4).
 *
 * `dateFrom`/`dateTo` are REQUIRED ISO-8601 dates (UTC day granularity, filtered
 * on the return's creation time); an invalid value is a 400. `warehouseId` is an
 * optional public-id filter intersected with the caller's warehouse scope;
 * `status` is a whitelisted return-status filter. Unknown keys are rejected.
 */
export class ReturnsReportQuery {
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

  @ApiPropertyOptional({ enum: RETURN_STATUS_FILTERS, description: 'Filter by return status.' })
  @IsOptional()
  @IsIn(RETURN_STATUS_FILTERS)
  status?: string;
}
