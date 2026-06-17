import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { OrderListView, OrderView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { ListOrdersQuery } from './dto/list-orders.query';
import { OrderListResponse, OrderResponse } from './dto/order-response.dto';

/**
 * Order REST surface (Order Draft Foundation).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches the required permission per route via
 * `@RequirePermissions`, so coverage cannot drift behind a forgotten local guard
 * (PERMISSION_MATRIX §3). The owning tenant is always the principal's real company
 * (DB-resolved), never the request body, and every depot-bound route additionally
 * passes a warehouse-scope check inside the service.
 *
 * Response schemas are documented with explicit `@Api*Response({ type })` models so
 * generated OpenAPI bodies are non-empty; the runtime shape is unchanged.
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('order:create')
  @ApiOperation({ summary: 'Create a DRAFT order in the caller’s company.' })
  @ApiCreatedResponse({ type: OrderResponse, description: 'The created DRAFT order.' })
  create(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateOrderDto,
    @Req() req: Request,
  ): Promise<OrderView> {
    return this.orders.create(principal, dto, requestMeta(req));
  }

  @Get()
  @RequirePermissions('order:read')
  @ApiOperation({ summary: 'List the caller’s company orders (paginated, scope-filtered).' })
  @ApiOkResponse({ type: OrderListResponse, description: 'A page of orders.' })
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListOrdersQuery,
  ): Promise<OrderListView> {
    return this.orders.list(principal, query);
  }

  @Get(':id')
  @RequirePermissions('order:read')
  @ApiOperation({ summary: 'Get one order by public id.' })
  @ApiOkResponse({ type: OrderResponse, description: 'The order.' })
  getOne(@CurrentUser() principal: AuthPrincipal, @Param('id') id: string): Promise<OrderView> {
    return this.orders.getOne(principal, id);
  }

  @Patch(':id')
  @RequirePermissions('order:update')
  @ApiOperation({ summary: 'Update a DRAFT order (safely replaces the whole draft content).' })
  @ApiOkResponse({ type: OrderResponse, description: 'The updated DRAFT order.' })
  update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
    @Req() req: Request,
  ): Promise<OrderView> {
    return this.orders.update(principal, id, dto, requestMeta(req));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:cancel')
  @ApiOperation({ summary: 'Cancel a DRAFT order (no stock effect).' })
  @ApiOkResponse({ type: OrderResponse, description: 'The cancelled order.' })
  cancel(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @Req() req: Request,
  ): Promise<OrderView> {
    return this.orders.cancel(principal, id, dto, requestMeta(req));
  }
}
