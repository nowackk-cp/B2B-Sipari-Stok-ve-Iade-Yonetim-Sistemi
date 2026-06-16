import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
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
import type {
  StockBalanceListView,
  StockMovementListView,
  StockMovementView,
} from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { StockService } from './stock.service';
import { CreateStockAdjustmentDto } from './dto/create-adjustment.dto';
import { ListStockBalancesQuery } from './dto/list-balances.query';
import { ListStockMovementsQuery } from './dto/list-movements.query';
import {
  StockBalanceListResponse,
  StockMovementListResponse,
  StockMovementResponse,
} from './dto/stock-response.dto';

/**
 * Inventory (stock) REST surface (Stock Ledger Foundation).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches the required permission per route. The guard
 * answers "may they do X?"; the service additionally enforces tenant isolation
 * and warehouse SCOPE, all resolved from PostgreSQL (never a JWT claim).
 *
 * Response schemas are documented with explicit `@Api*Response({ type })` models
 * so generated OpenAPI bodies are non-empty; the runtime shape is unchanged.
 */
@ApiTags('stock')
@ApiBearerAuth()
@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Post('adjustments')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('stock:adjust')
  @ApiOperation({ summary: 'Adjust on-hand stock (append-only movement + balance).' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated key; a replay returns the same movement (no duplicate).',
  })
  @ApiCreatedResponse({ type: StockMovementResponse, description: 'The recorded stock movement.' })
  adjust(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateStockAdjustmentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
  ): Promise<StockMovementView> {
    return this.stock.adjust(principal, dto, idempotencyKey, requestMeta(req));
  }

  @Get('balances')
  @RequirePermissions('stock:read')
  @ApiOperation({ summary: 'List current stock balances the caller may see (paginated).' })
  @ApiOkResponse({ type: StockBalanceListResponse, description: 'A page of stock balances.' })
  listBalances(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListStockBalancesQuery,
  ): Promise<StockBalanceListView> {
    return this.stock.listBalances(principal, query);
  }

  @Get('movements')
  @RequirePermissions('stock:read')
  @ApiOperation({ summary: 'List append-only stock movements the caller may see (paginated).' })
  @ApiOkResponse({ type: StockMovementListResponse, description: 'A page of stock movements.' })
  listMovements(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListStockMovementsQuery,
  ): Promise<StockMovementListView> {
    return this.stock.listMovements(principal, query);
  }
}
