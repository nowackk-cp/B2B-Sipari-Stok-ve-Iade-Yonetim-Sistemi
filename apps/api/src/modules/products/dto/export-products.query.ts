import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBooleanString, IsNumberString, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Filters for `GET /products/export`. Mirrors the product-list filters (search
 * over SKU/name, optional isActive, category) so the same query that lists the
 * catalog exports it — but without pagination (the whole filtered set is
 * returned). Unknown query keys are rejected by the strict pipe. When `isActive`
 * is omitted the export defaults to ACTIVE products.
 */
export class ExportProductsQuery {
  @ApiPropertyOptional({ description: 'Case-insensitive search over SKU and name.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by active flag ("true"/"false"). Default: true.' })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;

  @ApiPropertyOptional({ description: 'Filter by category id (string).' })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  categoryId?: string;
}
