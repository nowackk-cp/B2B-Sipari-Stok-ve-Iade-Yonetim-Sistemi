import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { CreateOrderItemDto, MAX_ORDER_ITEMS } from './create-order.dto';

/**
 * Update-order command DTO (Order Draft Foundation). A PATCH that safely replaces
 * the WHOLE draft content (task rule 21): there is no per-line add/remove endpoint.
 * Every field is optional; an absent field is left unchanged. When `items` is
 * present it must hold at least one line and REPLACES all existing lines (totals
 * are recomputed server-side). The same strict, server-priced item validation as
 * create applies (client prices are rejected). Only DRAFT orders may be patched.
 */
export class UpdateOrderDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'New customer (public id).' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'New source warehouse (public id).' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({
    type: [CreateOrderItemDto],
    description: 'Replacement order lines (at least one). Replaces ALL existing lines.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items?: CreateOrderItemDto[];

  @ApiPropertyOptional({ nullable: true, example: 'Updated note.', description: 'Note.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}
