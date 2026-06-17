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

/** Upper bound on lines per order — a sane request-size guard, not a business rule. */
export const MAX_ORDER_ITEMS = 200;

/**
 * One requested order line. Strict boundary validation (API_CONVENTIONS §7): the
 * ONLY accepted fields are the product and the quantity. `unitPrice`, `vatRate`
 * and any `*_amount` are NOT fields — the global ValidationPipe runs with
 * `forbidNonWhitelisted`, so a line carrying a client price (or any unknown key)
 * is REJECTED (400). Price, tax rate and currency are SERVER-derived from the
 * product (ORDER_RULES §2a / CLAUDE rule 16); overriding them needs
 * `order:price:override`, which is out of scope for this draft slice.
 */
export class CreateOrderItemDto {
  @ApiProperty({ format: 'uuid', description: 'Public id of the product to order.' })
  @IsUUID()
  productId!: string;

  @ApiProperty({
    example: '2',
    description: 'Positive quantity to order (integer string, 1..9223372036854775807).',
  })
  @IsBigIntString()
  quantity!: string;
}

/**
 * Create-order command DTO (Order Draft Foundation).
 *
 * Strict boundary validation. `companyId` is NOT a field: a body carrying it (or
 * any unknown key, including `status`/`subtotal`/`total`) is REJECTED (400) — the
 * order is always written to the actor's REAL company, resolved from PostgreSQL,
 * never a JWT claim or the body. The customer/warehouse/products are addressed by
 * their PUBLIC UUIDs and always resolved WITHIN that company.
 */
export class CreateOrderDto {
  @ApiProperty({ format: 'uuid', description: 'Public id of the customer.' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ format: 'uuid', description: 'Public id of the source warehouse.' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    type: [CreateOrderItemDto],
    description: 'Order lines (at least one).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];

  @ApiPropertyOptional({ nullable: true, example: 'Deliver before noon.', description: 'Note.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}
