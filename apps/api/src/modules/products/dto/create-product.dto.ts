import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MoneyInputDto } from './money.dto';

/**
 * Create-product command DTO (TASK-011).
 *
 * Strict boundary validation (API_CONVENTIONS §7). `companyId` is NOT a field:
 * the ValidationPipe runs with `forbidNonWhitelisted`, so a body carrying
 * `companyId` (or any unknown key) is REJECTED (400) — the product is always
 * written to the actor's REAL company, resolved from PostgreSQL (rule 4).
 */
export class CreateProductDto {
  @ApiProperty({
    example: 'SKU-001',
    description: 'Stock keeping unit (unique among the company’s active products).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @ApiProperty({ example: 'Widget', description: 'Product display name.' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ nullable: true, description: 'Free-text description.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '8690000000017',
    description: 'Barcode (non-unique).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string | null;

  @ApiPropertyOptional({ example: 'EACH', description: 'Unit of measure (default EACH).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  unit?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '12',
    description: 'Category id (string) or null.',
  })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  categoryId?: string | null;

  @ApiPropertyOptional({
    example: 2000,
    description: 'VAT rate in basis points (2000 = 20%), 0..10000.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  vatRate?: number;

  @ApiPropertyOptional({
    type: MoneyInputDto,
    description: 'List price (minor-unit string + currency).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MoneyInputDto)
  listPrice?: MoneyInputDto;

  @ApiPropertyOptional({ example: true, description: 'Active flag (default true).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    example: '10',
    description: 'Low-stock alert threshold (non-negative integer string) or null.',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'criticalStockThreshold must be a non-negative integer string' })
  @MaxLength(20)
  criticalStockThreshold?: string | null;
}
