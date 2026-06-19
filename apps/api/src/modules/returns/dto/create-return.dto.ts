import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsBigIntString } from '../../../common/validation/is-bigint-string.decorator';

/** Upper bound on lines per return — a sane request-size guard, not a business rule. */
export const MAX_RETURN_ITEMS = 200;

/**
 * One requested return line. Strict boundary validation (API_CONVENTIONS §7): the
 * ONLY accepted fields are the product, the quantity and an optional reason. The
 * line is bound to an ORDER line by its product UUID (an order has at most one line
 * per product), so no internal order-item id is ever exposed or accepted. The
 * returnable quantity is computed SERVER-side from the shipped quantity minus
 * already-returned quantity — the client cannot widen it.
 */
export class CreateReturnItemDto {
  @ApiProperty({ format: 'uuid', description: 'Public id of the product being returned.' })
  @IsUUID()
  productId!: string;

  @ApiProperty({
    example: '1',
    description: 'Positive quantity to return (integer string, 1..9223372036854775807).',
  })
  @IsBigIntString()
  quantity!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Damaged on arrival.',
    description: 'Line note.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string | null;
}

/**
 * Create-return command DTO (Return/Refund Foundation).
 *
 * Strict boundary validation. `companyId`/`warehouseId`/`status` are NOT fields: a
 * body carrying any of them (or any unknown key) is REJECTED (400) — the return is
 * always written to the actor's REAL company and the ORDER's warehouse, resolved
 * from PostgreSQL, never a JWT claim or the body. The order is addressed by its
 * PUBLIC UUID in the route; each line's product by its PUBLIC UUID.
 */
export class CreateReturnDto {
  @ApiProperty({
    type: [CreateReturnItemDto],
    description: 'Return lines (at least one).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RETURN_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => CreateReturnItemDto)
  items!: CreateReturnItemDto[];

  @ApiPropertyOptional({
    nullable: true,
    example: 'Customer changed mind.',
    description: 'Reason.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string | null;
}
