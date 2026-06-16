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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { ProductListView, ProductView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQuery } from './dto/list-products.query';

/**
 * Product catalog REST surface (TASK-011).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches the required permission per route via
 * `@RequirePermissions`, so coverage cannot drift behind a forgotten local guard
 * (PERMISSION_MATRIX §3). The owning tenant is always the principal's real
 * company (DB-resolved), never the request body.
 */
@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('product:create')
  @ApiOperation({ summary: 'Create a product in the caller’s company.' })
  create(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateProductDto,
    @Req() req: Request,
  ): Promise<ProductView> {
    return this.products.create(principal, dto, requestMeta(req));
  }

  @Get()
  @RequirePermissions('product:read')
  @ApiOperation({ summary: 'List/search the caller’s company products (paginated).' })
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListProductsQuery,
  ): Promise<ProductListView> {
    return this.products.list(principal, query);
  }

  @Get(':id')
  @RequirePermissions('product:read')
  @ApiOperation({ summary: 'Get one product by public id.' })
  getOne(@CurrentUser() principal: AuthPrincipal, @Param('id') id: string): Promise<ProductView> {
    return this.products.getOne(principal, id);
  }

  @Patch(':id')
  @RequirePermissions('product:update')
  @ApiOperation({ summary: 'Update a product in the caller’s company.' })
  update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: Request,
  ): Promise<ProductView> {
    return this.products.update(principal, id, dto, requestMeta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('product:delete')
  @ApiOperation({ summary: 'Soft-delete a product in the caller’s company.' })
  remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.products.remove(principal, id, requestMeta(req));
  }
}
