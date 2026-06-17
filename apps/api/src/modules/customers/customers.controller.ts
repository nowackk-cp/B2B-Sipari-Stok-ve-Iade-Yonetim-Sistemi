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
import type { CustomerListView, CustomerView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQuery } from './dto/list-customers.query';
import { CustomerListResponse, CustomerResponse } from './dto/customer-response.dto';

/**
 * Customer master-data REST surface (Customer Management Foundation).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches the required permission per route via
 * `@RequirePermissions`, so coverage cannot drift behind a forgotten local guard
 * (PERMISSION_MATRIX §3). The owning tenant is always the principal's real
 * company (DB-resolved), never the request body.
 *
 * Response schemas are documented with explicit `@Api*Response({ type })` models
 * (the contract interfaces carry no runtime metadata) so generated OpenAPI bodies
 * are non-empty; the runtime shape is unchanged.
 */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('customer:create')
  @ApiOperation({ summary: 'Create a customer in the caller’s company.' })
  @ApiCreatedResponse({ type: CustomerResponse, description: 'The created customer.' })
  create(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateCustomerDto,
    @Req() req: Request,
  ): Promise<CustomerView> {
    return this.customers.create(principal, dto, requestMeta(req));
  }

  @Get()
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'List/search the caller’s company customers (paginated).' })
  @ApiOkResponse({ type: CustomerListResponse, description: 'A page of customers.' })
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListCustomersQuery,
  ): Promise<CustomerListView> {
    return this.customers.list(principal, query);
  }

  @Get(':id')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'Get one customer by public id.' })
  @ApiOkResponse({ type: CustomerResponse, description: 'The customer.' })
  getOne(@CurrentUser() principal: AuthPrincipal, @Param('id') id: string): Promise<CustomerView> {
    return this.customers.getOne(principal, id);
  }

  @Patch(':id')
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Update a customer in the caller’s company.' })
  @ApiOkResponse({ type: CustomerResponse, description: 'The updated customer.' })
  update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @Req() req: Request,
  ): Promise<CustomerView> {
    return this.customers.update(principal, id, dto, requestMeta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customer:delete')
  @ApiOperation({ summary: 'Soft-delete a customer in the caller’s company.' })
  @ApiNoContentResponse({ description: 'The customer was soft-deleted (no content).' })
  remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.customers.remove(principal, id, requestMeta(req));
  }
}
