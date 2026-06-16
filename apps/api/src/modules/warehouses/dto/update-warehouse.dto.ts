import { PartialType } from '@nestjs/swagger';
import { CreateWarehouseDto } from './create-warehouse.dto';

/**
 * Update-warehouse command DTO (PATCH, TASK-012). Every field is optional; the
 * same strict validators apply when a field is present. `companyId` is still not
 * a field, so a warehouse can never be moved across tenants via update.
 */
export class UpdateWarehouseDto extends PartialType(CreateWarehouseDto) {}
