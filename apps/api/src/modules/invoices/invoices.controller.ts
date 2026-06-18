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
import type { InvoiceListView, InvoiceView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesQuery } from './dto/list-invoices.query';
import { InvoiceListResponse, InvoiceResponse } from './dto/invoice-response.dto';

/**
 * Invoice REST surface (Invoice/Billing Foundation).
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
@ApiTags('invoices')
@ApiBearerAuth()
@Controller()
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post('orders/:id/invoice')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('invoice:create')
  @ApiOperation({ summary: 'Issue an invoice for a SHIPPED order (gapless number, idempotent).' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated key; a replay returns the same invoice (no duplicate).',
  })
  @ApiCreatedResponse({ type: InvoiceResponse, description: 'The issued invoice (status ISSUED).' })
  createForOrder(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    // Strict-empty body: the issue command takes no client fields. Any supplied
    // field (total/price/companyId/…) is rejected with a 400 by the global pipe.
    @Body() _dto: CreateInvoiceDto,
    @Req() req: Request,
  ): Promise<InvoiceView> {
    return this.invoices.createForOrder(principal, id, idempotencyKey, requestMeta(req));
  }

  @Get('invoices')
  @RequirePermissions('invoice:read')
  @ApiOperation({ summary: 'List the caller’s company invoices (paginated, scope-filtered).' })
  @ApiOkResponse({ type: InvoiceListResponse, description: 'A page of invoices.' })
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListInvoicesQuery,
  ): Promise<InvoiceListView> {
    return this.invoices.list(principal, query);
  }

  @Get('invoices/:id')
  @RequirePermissions('invoice:read')
  @ApiOperation({ summary: 'Get one invoice by public id.' })
  @ApiOkResponse({ type: InvoiceResponse, description: 'The invoice.' })
  getOne(@CurrentUser() principal: AuthPrincipal, @Param('id') id: string): Promise<InvoiceView> {
    return this.invoices.getOne(principal, id);
  }
}
