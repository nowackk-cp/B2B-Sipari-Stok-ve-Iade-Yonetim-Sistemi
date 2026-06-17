import { PartialType } from '@nestjs/swagger';
import { CreateCustomerDto } from './create-customer.dto';

/**
 * Update-customer command DTO (PATCH, Customer Management Foundation). Every
 * field is optional; the same strict validators apply when a field is present.
 * `companyId` is still not a field, so a customer can never be moved across
 * tenants via update.
 */
export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}
