import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Allowed customer kinds (DATABASE_DESIGN §8 `type`). */
export const CUSTOMER_TYPES = ['COMPANY', 'INDIVIDUAL'] as const;

/**
 * Create-customer command DTO (Customer Management Foundation).
 *
 * Strict boundary validation (API_CONVENTIONS §7). `companyId` is NOT a field:
 * the ValidationPipe runs with `forbidNonWhitelisted`, so a body carrying
 * `companyId` (or any unknown key) is REJECTED (400) — the customer is always
 * written to the actor's REAL company, resolved from PostgreSQL (rule 2/3/4).
 */
export class CreateCustomerDto {
  @ApiProperty({
    example: 'CUST-001',
    description: 'Customer code/number (unique among the company’s active customers).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @ApiProperty({ example: 'Acme Ltd.', description: 'Customer display name.' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    enum: CUSTOMER_TYPES,
    example: 'COMPANY',
    description: 'Customer kind (default COMPANY).',
  })
  @IsOptional()
  @IsIn(CUSTOMER_TYPES)
  type?: string;

  @ApiPropertyOptional({ nullable: true, example: '1234567890', description: 'Tax number.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'billing@acme.example' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+90 212 000 0000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;
}
