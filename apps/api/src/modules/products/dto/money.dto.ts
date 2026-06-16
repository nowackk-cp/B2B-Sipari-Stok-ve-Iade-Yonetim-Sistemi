import { ApiProperty } from '@nestjs/swagger';
import { Matches, MaxLength } from 'class-validator';

/**
 * Money input: a minor-unit STRING amount + ISO currency (API_CONVENTIONS §5).
 * Never a JS number — `amount` is validated as a non-negative integer string and
 * parsed to BigInt server-side (ADR-005).
 */
export class MoneyInputDto {
  @ApiProperty({
    example: '12345',
    description: 'Amount in minor units (non-negative integer string).',
  })
  @Matches(/^\d+$/, { message: 'amount must be a non-negative integer string' })
  @MaxLength(20)
  amount!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency code (3 letters).' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency!: string;
}
