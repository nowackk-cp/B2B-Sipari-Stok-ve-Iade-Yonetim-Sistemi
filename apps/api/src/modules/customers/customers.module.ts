import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CustomerRepository } from './customer.repository';

/**
 * Customer master-data module (Customer Management Foundation). Owns the
 * `customers` table via {@link CustomerRepository} (MODULE_BOUNDARIES §2). Imports
 * AuthorizationModule so the globally-bound PermissionGuard can resolve its
 * services in this context; authentication providers and the AuditWriter are
 * global. The clock, database and audit modules are global, so no further imports
 * are needed.
 */
@Module({
  imports: [AuthorizationModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerRepository],
  exports: [CustomersService],
})
export class CustomersModule {}
