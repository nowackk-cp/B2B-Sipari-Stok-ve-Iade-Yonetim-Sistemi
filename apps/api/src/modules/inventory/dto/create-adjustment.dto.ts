import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { StockAdjustmentDirection } from '@b2b/contracts';
import { IsBigIntString } from '../../../common/validation/is-bigint-string.decorator';

/**
 * Create-stock-adjustment command DTO (Stock Ledger Foundation).
 *
 * Strict boundary validation (API_CONVENTIONS §7). `companyId` is NOT a field:
 * the ValidationPipe runs with `forbidNonWhitelisted`, so a body carrying
 * `companyId` (or any unknown key) is REJECTED (400). The target warehouse and
 * product are addressed by their PUBLIC UUIDs and are always resolved WITHIN the
 * actor's real company (resolved from PostgreSQL, never a JWT claim) — so a
 * forged claim can neither pick another tenant's warehouse/product nor smuggle a
 * tenant in the body.
 *
 * `quantity` is the POSITIVE magnitude of the change as a BIGINT string; the
 * `direction` decides its sign. `IsBigIntString` already rejects negative,
 * decimal, empty and over-BIGINT values with a clean 400 (never a DB-overflow
 * 500); the service additionally rejects `0` (an adjustment must move stock).
 */
export class CreateStockAdjustmentDto {
  @ApiProperty({ format: 'uuid', description: 'Public id of the target warehouse.' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public id of the target product.' })
  @IsUUID()
  productId!: string;

  @ApiProperty({
    enum: ['INCREASE', 'DECREASE'],
    description: 'Whether the adjustment raises or lowers on-hand.',
  })
  @IsIn(['INCREASE', 'DECREASE'])
  direction!: StockAdjustmentDirection;

  @ApiProperty({
    example: '10',
    description: 'Positive magnitude of the change (integer string, 1..9223372036854775807).',
  })
  @IsBigIntString()
  quantity!: string;

  @ApiProperty({
    example: 'Initial stock',
    description: 'Reason for the manual adjustment (required — INVENTORY_RULES §7).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
