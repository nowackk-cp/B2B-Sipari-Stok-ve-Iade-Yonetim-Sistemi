import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DashboardSummaryView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { ReportsService } from './reports.service';
import { DashboardSummaryResponse } from './dto/report-response.dto';

/**
 * Dashboard REST surface (Dashboard / Reports Backend Foundation).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches the required permission per route. The owning
 * tenant is always the principal's real company (DB-resolved), never a JWT claim,
 * and warehouse-bound figures are intersected with the actor's warehouse scope in
 * the service. The route is READ-ONLY (no mutation, no audit).
 */
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  @RequirePermissions('dashboard:read')
  @ApiOperation({ summary: 'Management dashboard summary (company + warehouse-scoped counts).' })
  @ApiOkResponse({ type: DashboardSummaryResponse, description: 'The dashboard summary.' })
  summary(@CurrentUser() principal: AuthPrincipal): Promise<DashboardSummaryView> {
    return this.reports.summary(principal);
  }
}
