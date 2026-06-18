import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Invoice statuses a list query may filter by. */
export const INVOICE_STATUS_FILTERS = ['DRAFT', 'ISSUED', 'PAID', 'VOID'] as const;

/**
 * List/filter query for invoices (API_CONVENTIONS §4). Cursor-paginated:
 * `?limit=&cursor=`. `status` is a whitelisted filter; results are always
 * intersected with the actor's warehouse scope (never widened). Unknown query keys
 * are rejected by the strict pipe.
 */
export class ListInvoicesQuery {
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

  @ApiPropertyOptional({ enum: INVOICE_STATUS_FILTERS, description: 'Filter by invoice status.' })
  @IsOptional()
  @IsIn(INVOICE_STATUS_FILTERS)
  status?: string;
}
