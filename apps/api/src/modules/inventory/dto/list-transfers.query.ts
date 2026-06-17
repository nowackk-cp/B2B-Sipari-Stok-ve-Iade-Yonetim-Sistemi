import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * List/filter query for stock transfers (Stock Transfer Foundation). Cursor
 * paginated (API_CONVENTIONS §4). `warehouseId`/`productId` are optional public-id
 * filters; a `warehouseId` filter matches the transfer's source OR destination.
 * Every result is still intersected with the actor's warehouse scope so a filter
 * can never widen access. Unknown query keys are rejected by the strict pipe.
 */
export class ListStockTransfersQuery {
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

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Filter to transfers touching this warehouse as source or destination (public id).',
  })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter to a single product (public id).' })
  @IsOptional()
  @IsUUID()
  productId?: string;
}
