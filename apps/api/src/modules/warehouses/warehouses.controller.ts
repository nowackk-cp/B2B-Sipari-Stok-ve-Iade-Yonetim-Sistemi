import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { WarehouseListView, WarehouseView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { WarehousesService } from './warehouses.service';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import { ListWarehousesQuery } from './dto/list-warehouses.query';
import { WarehouseListResponse, WarehouseResponse } from './dto/warehouse-response.dto';

/**
 * Warehouse master-data REST surface (TASK-012).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches the required permission per route via
 * `@RequirePermissions`, so coverage cannot drift behind a forgotten local guard
 * (PERMISSION_MATRIX §3). The permission guard answers "may they do X?"; the
 * service additionally enforces warehouse SCOPE for the per-warehouse routes
 * (read/update/delete) and tenant isolation throughout. The owning tenant is
 * always the principal's real company (DB-resolved), never the request body.
 *
 * Response schemas are documented with explicit `@Api*Response({ type })` models
 * so generated OpenAPI bodies are non-empty; the runtime shape is unchanged.
 */
@ApiTags('warehouses')
@ApiBearerAuth()
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('warehouse:create')
  @ApiOperation({ summary: 'Create a warehouse in the caller’s company.' })
  @ApiCreatedResponse({ type: WarehouseResponse, description: 'The created warehouse.' })
  create(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateWarehouseDto,
    @Req() req: Request,
  ): Promise<WarehouseView> {
    return this.warehouses.create(principal, dto, requestMeta(req));
  }

  @Get()
  @RequirePermissions('warehouse:read')
  @ApiOperation({ summary: 'List/search the caller’s in-scope warehouses (paginated).' })
  @ApiOkResponse({ type: WarehouseListResponse, description: 'A page of warehouses.' })
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListWarehousesQuery,
  ): Promise<WarehouseListView> {
    return this.warehouses.list(principal, query);
  }

  @Get(':id')
  @RequirePermissions('warehouse:read')
  @ApiOperation({ summary: 'Get one warehouse by public id (requires scope to it).' })
  @ApiOkResponse({ type: WarehouseResponse, description: 'The warehouse.' })
  getOne(@CurrentUser() principal: AuthPrincipal, @Param('id') id: string): Promise<WarehouseView> {
    return this.warehouses.getOne(principal, id);
  }

  @Patch(':id')
  @RequirePermissions('warehouse:update')
  @ApiOperation({ summary: 'Update a warehouse in the caller’s company (requires scope to it).' })
  @ApiOkResponse({ type: WarehouseResponse, description: 'The updated warehouse.' })
  update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateWarehouseDto,
    @Req() req: Request,
  ): Promise<WarehouseView> {
    return this.warehouses.update(principal, id, dto, requestMeta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('warehouse:delete')
  @ApiOperation({
    summary: 'Soft-delete a warehouse in the caller’s company (requires scope to it).',
  })
  @ApiNoContentResponse({ description: 'The warehouse was soft-deleted (no content).' })
  remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.warehouses.remove(principal, id, requestMeta(req));
  }
}
