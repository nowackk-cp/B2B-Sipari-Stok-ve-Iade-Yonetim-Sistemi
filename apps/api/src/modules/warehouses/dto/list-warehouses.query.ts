import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * List/search/filter query for warehouses (API_CONVENTIONS §4). Cursor-paginated:
 * `?limit=&cursor=`. `search` matches code or name; `isActive` is a whitelisted
 * filter. Unknown query keys are rejected by the strict pipe.
 */
export class ListWarehousesQuery {
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

  @ApiPropertyOptional({ description: 'Case-insensitive search over code and name.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by active flag ("true"/"false").' })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;
}
