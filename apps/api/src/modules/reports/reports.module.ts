import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { DashboardController } from './dashboard.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportsRepository } from './reports.repository';

/**
 * Dashboard / Reports module (Dashboard / Reports Backend Foundation, MODULE_BOUNDARIES
 * M19 "dashboard — aggregate read"). Owns NO tables: it serves READ-ONLY aggregate
 * endpoints over the catalog, customer, order, inventory, invoice, return and
 * credit-note data through {@link ReportsRepository}. It writes nothing and opens no
 * transaction. Imports AuthorizationModule so the globally-bound PermissionGuard and
 * the WarehouseScopeService resolve in this context; the clock and database modules
 * are global.
 */
@Module({
  imports: [AuthorizationModule],
  controllers: [DashboardController, ReportsController],
  providers: [ReportsService, ReportsRepository],
})
export class ReportsModule {}
