import { PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';

/**
 * Update-product command DTO (PATCH, TASK-011). Every field is optional; the same
 * strict validators apply when a field is present. `companyId` is still not a
 * field, so a product can never be moved across tenants via update.
 */
export class UpdateProductDto extends PartialType(CreateProductDto) {}
