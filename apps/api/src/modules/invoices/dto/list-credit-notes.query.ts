import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Credit note statuses a list query may filter by (shares the invoice_status enum). */
export const CREDIT_NOTE_STATUS_FILTERS = ['ISSUED', 'VOID'] as const;

/**
 * List/filter query for credit notes (API_CONVENTIONS §4). Cursor-paginated:
 * `?limit=&cursor=`. `status` is a whitelisted filter; results are always
 * intersected with the actor's warehouse scope (never widened). Unknown query keys
 * are rejected by the strict pipe.
 */
export class ListCreditNotesQuery {
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
    enum: CREDIT_NOTE_STATUS_FILTERS,
    description: 'Filter by credit note status.',
  })
  @IsOptional()
  @IsIn(CREDIT_NOTE_STATUS_FILTERS)
  status?: string;
}
