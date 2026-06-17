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
import type {
  StockBalanceListView,
  StockMovementListView,
  StockMovementView,
  StockTransferListView,
  StockTransferView,
} from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { StockService } from './stock.service';
import { CreateStockAdjustmentDto } from './dto/create-adjustment.dto';
import { CreateStockTransferDto } from './dto/create-transfer.dto';
import { ListStockBalancesQuery } from './dto/list-balances.query';
import { ListStockMovementsQuery } from './dto/list-movements.query';
import { ListStockTransfersQuery } from './dto/list-transfers.query';
import {
  StockBalanceListResponse,
  StockMovementListResponse,
  StockMovementResponse,
  StockTransferListResponse,
  StockTransferResponse,
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

  @Post('transfers')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('stock:transfer')
  @ApiOperation({
    summary: 'Atomically transfer a product between two warehouses (same company).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated key; a replay returns the same transfer (no duplicate).',
  })
  @ApiCreatedResponse({ type: StockTransferResponse, description: 'The recorded stock transfer.' })
  transfer(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateStockTransferDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
  ): Promise<StockTransferView> {
    return this.stock.transfer(principal, dto, idempotencyKey, requestMeta(req));
  }

  @Get('transfers')
  @RequirePermissions('stock:read')
  @ApiOperation({ summary: 'List the stock transfers the caller may see (paginated).' })
  @ApiOkResponse({ type: StockTransferListResponse, description: 'A page of stock transfers.' })
  listTransfers(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListStockTransfersQuery,
  ): Promise<StockTransferListView> {
    return this.stock.listTransfers(principal, query);
  }

  @Get('transfers/:id')
  @RequirePermissions('stock:read')
  @ApiOperation({ summary: 'Get one stock transfer by public id (requires source or dest scope).' })
  @ApiOkResponse({ type: StockTransferResponse, description: 'The stock transfer.' })
  getTransfer(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<StockTransferView> {
    return this.stock.getTransfer(principal, id);
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
