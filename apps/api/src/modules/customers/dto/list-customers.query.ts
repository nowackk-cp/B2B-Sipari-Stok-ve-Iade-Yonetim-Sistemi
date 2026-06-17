import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CUSTOMER_TYPES } from './create-customer.dto';

/**
 * List/search/filter query for customers (API_CONVENTIONS §4). Cursor-paginated:
 * `?limit=&cursor=`. `search` matches code/name/email/taxNumber; `type` is a
 * whitelisted filter. Unknown query keys are rejected by the strict pipe.
 */
export class ListCustomersQuery {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Page size (default 20, max 100).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page’s pageInfo.nextCursor.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Case-insensitive search over code, name, email and tax number.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_TYPES, description: 'Filter by customer kind.' })
  @IsOptional()
  @IsIn(CUSTOMER_TYPES)
  type?: string;
}
