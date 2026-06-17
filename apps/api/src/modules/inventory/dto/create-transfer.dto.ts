import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsBigIntString } from '../../../common/validation/is-bigint-string.decorator';

/**
 * Create-stock-transfer command DTO (Stock Transfer Foundation).
 *
 * Strict boundary validation (API_CONVENTIONS §7). `companyId` is NOT a field:
 * the ValidationPipe runs with `forbidNonWhitelisted`, so a body carrying
 * `companyId` (or any unknown key) is REJECTED (400, task rule 15). The product
 * and both warehouses are addressed by their PUBLIC UUIDs and are always resolved
 * WITHIN the actor's real company (resolved from PostgreSQL, never a JWT claim),
 * so a forged claim can neither pick another tenant's resources nor smuggle a
 * tenant in the body (task rules 11/14).
 *
 * `quantity` is the POSITIVE amount to move as a BIGINT string; `IsBigIntString`
 * already rejects negative, decimal, empty and over-BIGINT values with a clean
 * 400 (never a DB-overflow 500). The service additionally rejects `0` (a transfer
 * must move stock) and rejects `from == to` (task rules 7/16/17).
 */
export class CreateStockTransferDto {
  @ApiProperty({ format: 'uuid', description: 'Public id of the source warehouse (on-hand −).' })
  @IsUUID()
  fromWarehouseId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Public id of the destination warehouse (on-hand +).',
  })
  @IsUUID()
  toWarehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public id of the product to move.' })
  @IsUUID()
  productId!: string;

  @ApiProperty({
    example: '10',
    description: 'Positive amount to move (integer string, 1..9223372036854775807).',
  })
  @IsBigIntString()
  quantity!: string;

  @ApiProperty({
    example: 'Warehouse transfer',
    description: 'Reason for the transfer (required).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
