import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { CreditNoteListView, CreditNoteView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CreditNotesService } from './credit-notes.service';
import { CreateCreditNoteDto } from './dto/create-credit-note.dto';
import { ListCreditNotesQuery } from './dto/list-credit-notes.query';
import { CreditNoteListResponse, CreditNoteResponse } from './dto/credit-note-response.dto';

/**
 * Credit note REST surface (Return Invoice / Credit Note Foundation).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches the required permission per route via
 * `@RequirePermissions`. The owning tenant is always the principal's real company
 * (DB-resolved), never the request body, and every route additionally passes a
 * warehouse-scope check inside the service.
 *
 * Response schemas are documented with explicit `@Api*Response({ type })` models so
 * generated OpenAPI bodies are non-empty; the runtime shape is unchanged.
 */
@ApiTags('credit-notes')
@ApiBearerAuth()
@Controller()
export class CreditNotesController {
  constructor(private readonly creditNotes: CreditNotesService) {}

  @Post('returns/:id/credit-note')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('credit-note:create')
  @ApiOperation({
    summary: 'Issue a credit note for an APPROVED return (gapless number, idempotent).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated key; a replay returns the same credit note (no duplicate).',
  })
  @ApiCreatedResponse({
    type: CreditNoteResponse,
    description: 'The issued credit note (status ISSUED).',
  })
  createForReturn(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    // Strict-empty body: the issue command takes no client fields. Any supplied
    // field (total/price/companyId/…) is rejected with a 400 by the global pipe.
    @Body() _dto: CreateCreditNoteDto,
    @Req() req: Request,
  ): Promise<CreditNoteView> {
    return this.creditNotes.createForReturn(principal, id, idempotencyKey, requestMeta(req));
  }

  @Get('credit-notes')
  @RequirePermissions('credit-note:read')
  @ApiOperation({ summary: 'List the caller’s company credit notes (paginated, scope-filtered).' })
  @ApiOkResponse({ type: CreditNoteListResponse, description: 'A page of credit notes.' })
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListCreditNotesQuery,
  ): Promise<CreditNoteListView> {
    return this.creditNotes.list(principal, query);
  }

  @Get('credit-notes/:id')
  @RequirePermissions('credit-note:read')
  @ApiOperation({ summary: 'Get one credit note by public id.' })
  @ApiOkResponse({ type: CreditNoteResponse, description: 'The credit note.' })
  getOne(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<CreditNoteView> {
    return this.creditNotes.getOne(principal, id);
  }
}
