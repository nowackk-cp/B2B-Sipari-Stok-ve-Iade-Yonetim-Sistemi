import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Query for the inventory report (`GET /reports/inventory`, API_CONVENTIONS §4).
 * Cursor-paginated. `warehouseId` is an optional public-id filter intersected
 * with the caller's warehouse scope; `lowStockOnly` keeps only balances at/below
 * the product's critical threshold; `search` matches product name or SKU
 * (case-insensitive). Unknown query keys are rejected by the strict pipe.
 */
export class InventoryReportQuery {
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

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter to a single warehouse (public id).' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({ description: 'Keep only low-stock balances (available ≤ threshold).' })
  @IsOptional()
  // Query strings arrive as text; coerce the documented truthy spellings to a
  // boolean (implicit conversion is disabled globally) before @IsBoolean.
  @Transform(({ value }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  lowStockOnly?: boolean;

  @ApiPropertyOptional({ description: 'Case-insensitive match on product name or SKU.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  search?: string;
}
