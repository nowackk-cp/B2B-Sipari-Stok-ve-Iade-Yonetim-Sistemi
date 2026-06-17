import { ApiProperty } from '@nestjs/swagger';
import type { CustomerListView, CustomerView, PageInfo } from '@b2b/contracts';

/**
 * Swagger RESPONSE models (Customer Management Foundation).
 *
 * The controller's return types are the `@b2b/contracts` INTERFACES, which carry
 * no runtime metadata, so generated OpenAPI response bodies would be empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each `implements`
 * its contract interface so the documented shape can never drift from the wire
 * shape (a field rename/removal breaks the build). They are never instantiated —
 * the service still returns plain objects mapped by `toCustomerView`, so the
 * runtime response is unchanged.
 */
export class CustomerResponse implements CustomerView {
  @ApiProperty({ format: 'uuid', description: 'Public customer id (UUID).' })
  id!: string;

  @ApiProperty({ example: 'CUST-001' })
  code!: string;

  @ApiProperty({ example: 'Acme Ltd.' })
  name!: string;

  @ApiProperty({ example: 'COMPANY', description: 'Customer kind: COMPANY or INDIVIDUAL.' })
  type!: string;

  @ApiProperty({ type: String, nullable: true, example: '1234567890' })
  taxNumber!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'billing@acme.example' })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+90 212 000 0000' })
  phone!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class CustomerPageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class CustomerListResponse implements CustomerListView {
  @ApiProperty({ type: [CustomerResponse] })
  data!: CustomerResponse[];

  @ApiProperty({ type: CustomerPageInfoResponse })
  pageInfo!: CustomerPageInfoResponse;
}
