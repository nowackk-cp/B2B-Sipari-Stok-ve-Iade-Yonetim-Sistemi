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
import type { ReturnListView, ReturnView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { ReturnsService } from './returns.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ApproveReturnDto } from './dto/approve-return.dto';
import { ListReturnsQuery } from './dto/list-returns.query';
import { ReturnListResponse, ReturnResponse } from './dto/return-response.dto';

/**
 * Return / Refund REST surface (Return/Refund Foundation).
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
@ApiTags('returns')
@ApiBearerAuth()
@Controller()
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Post('orders/:id/returns')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('return:create')
  @ApiOperation({
    summary: 'Raise a return for a SHIPPED order (DRAFT, no stock effect, idempotent).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated key; a replay returns the same return (no duplicate).',
  })
  @ApiCreatedResponse({ type: ReturnResponse, description: 'The raised return (status DRAFT).' })
  create(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateReturnDto,
    @Req() req: Request,
  ): Promise<ReturnView> {
    return this.returns.create(principal, id, dto, idempotencyKey, requestMeta(req));
  }

  @Get('returns')
  @RequirePermissions('return:read')
  @ApiOperation({ summary: 'List the caller’s company returns (paginated, scope-filtered).' })
  @ApiOkResponse({ type: ReturnListResponse, description: 'A page of returns.' })
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListReturnsQuery,
  ): Promise<ReturnListView> {
    return this.returns.list(principal, query);
  }

  @Get('returns/:id')
  @RequirePermissions('return:read')
  @ApiOperation({ summary: 'Get one return by public id.' })
  @ApiOkResponse({ type: ReturnResponse, description: 'The return.' })
  getOne(@CurrentUser() principal: AuthPrincipal, @Param('id') id: string): Promise<ReturnView> {
    return this.returns.getOne(principal, id);
  }

  @Post('returns/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('return:approve')
  @ApiOperation({ summary: 'Approve a DRAFT return (atomically restocks: on_hand+, RETURN_IN).' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated key; a replay returns the same approved return (no duplicate).',
  })
  @ApiOkResponse({ type: ReturnResponse, description: 'The approved return (status APPROVED).' })
  approve(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    // Strict-empty body: the approve command takes no client fields. Any supplied
    // field is rejected with a 400 by the global pipe.
    @Body() _dto: ApproveReturnDto,
    @Req() req: Request,
  ): Promise<ReturnView> {
    return this.returns.approve(principal, id, idempotencyKey, requestMeta(req));
  }
}
