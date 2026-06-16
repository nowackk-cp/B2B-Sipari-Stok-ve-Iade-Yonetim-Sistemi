import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Create-warehouse command DTO (TASK-012).
 *
 * Strict boundary validation (API_CONVENTIONS §7). `companyId` is NOT a field:
 * the ValidationPipe runs with `forbidNonWhitelisted`, so a body carrying
 * `companyId` (or any unknown key) is REJECTED (400) — the warehouse is always
 * written to the actor's REAL company, resolved from PostgreSQL (rule 4).
 */
export class CreateWarehouseDto {
  @ApiProperty({
    example: 'MAIN',
    description: 'Warehouse code (unique among the company’s active warehouses).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: 'Main Warehouse', description: 'Warehouse display name.' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ nullable: true, description: 'Address line 1.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine1?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Address line 2.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Istanbul', description: 'City.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  city?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '34000', description: 'Postal code.' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  postalCode?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'TR',
    description: 'ISO 3166-1 alpha-2 country code (2 letters).',
  })
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be a 2-letter ISO code' })
  country?: string | null;

  @ApiPropertyOptional({ example: true, description: 'Active flag (default true).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
