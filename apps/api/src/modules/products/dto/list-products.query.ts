import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * List/search/filter query for products (API_CONVENTIONS §4). Cursor-paginated:
 * `?limit=&cursor=`. `search` matches SKU or name; `isActive`/`categoryId` are
 * whitelisted filters. Unknown query keys are rejected by the strict pipe.
 */
export class ListProductsQuery {
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

  @ApiPropertyOptional({ description: 'Case-insensitive search over SKU and name.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by active flag ("true"/"false").' })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;

  @ApiPropertyOptional({ description: 'Filter by category id (string).' })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  categoryId?: string;
}
