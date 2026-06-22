import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { InventoryReportView, ReturnsReportView, SalesReportView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { ReportsService } from './reports.service';
import { SalesReportQuery } from './dto/sales-report.query';
import { InventoryReportQuery } from './dto/inventory-report.query';
import { ReturnsReportQuery } from './dto/returns-report.query';
import {
  InventoryReportResponse,
  ReturnsReportResponse,
  SalesReportResponse,
} from './dto/report-response.dto';

/**
 * Reports REST surface (Dashboard / Reports Backend Foundation).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches `report:read` per route. Every report is filtered
 * by the principal's real company (DB-resolved, never a JWT claim) and intersected
 * with the actor's warehouse scope in the service. Routes are READ-ONLY (no
 * mutation, no audit). Invalid query parameters are 400 RFC 7807 problem+json.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermissions('report:read')
  @ApiOperation({ summary: 'Gross-sales report over ISSUED invoices (period + currency buckets).' })
  @ApiOkResponse({ type: SalesReportResponse, description: 'The aggregated sales report.' })
  sales(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: SalesReportQuery,
  ): Promise<SalesReportView> {
    return this.reports.salesReport(principal, query);
  }

  @Get('inventory')
  @RequirePermissions('report:read')
  @ApiOperation({ summary: 'Inventory report (balances with available + low-stock flag).' })
  @ApiOkResponse({ type: InventoryReportResponse, description: 'A page of inventory rows.' })
  inventory(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: InventoryReportQuery,
  ): Promise<InventoryReportView> {
    return this.reports.inventoryReport(principal, query);
  }

  @Get('returns')
  @RequirePermissions('report:read')
  @ApiOperation({ summary: 'Returns report (counts, returned quantity, credit-note totals).' })
  @ApiOkResponse({ type: ReturnsReportResponse, description: 'The aggregated returns report.' })
  returns(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ReturnsReportQuery,
  ): Promise<ReturnsReportView> {
    return this.reports.returnsReport(principal, query);
  }
}
