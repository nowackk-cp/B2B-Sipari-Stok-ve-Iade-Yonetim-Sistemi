import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** Order statuses a list query may filter by in this slice (DRAFT lifecycle). */
export const ORDER_STATUS_FILTERS = [
  'DRAFT',
  'APPROVED',
  'PREPARING',
  'SHIPPED',
  'CANCELLED',
] as const;

/**
 * List/filter query for orders (API_CONVENTIONS §4). Cursor-paginated:
 * `?limit=&cursor=`. `status` and `warehouseId` are whitelisted filters; the
 * warehouse filter is intersected with (never widens) the actor's warehouse scope.
 * Unknown query keys are rejected by the strict pipe.
 */
export class ListOrdersQuery {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Page size (default 20, max 100).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page’s pageInfo.nextCursor.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  cursor?: string;

  @ApiPropertyOptional({ enum: ORDER_STATUS_FILTERS, description: 'Filter by order status.' })
  @IsOptional()
  @IsIn(ORDER_STATUS_FILTERS)
  status?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter by source warehouse (public id).' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}
