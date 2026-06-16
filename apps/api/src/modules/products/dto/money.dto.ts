import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { IsBigIntString } from '../../../common/validation/is-bigint-string.decorator';

/**
 * Money input: a minor-unit STRING amount + ISO currency (API_CONVENTIONS §5).
 * Never a JS number — `amount` is validated as a non-negative integer string
 * within PostgreSQL BIGINT range and only then parsed to BigInt server-side
 * (ADR-005). An over-range amount is rejected as 400, never a DB overflow 500.
 */
export class MoneyInputDto {
  @ApiProperty({
    example: '12345',
    description: 'Amount in minor units (non-negative integer string, 0..9223372036854775807).',
  })
  @IsBigIntString()
  amount!: string;

  @ApiProperty({ example: 'TRY', description: 'ISO 4217 currency code (3 letters).' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency!: string;
}
