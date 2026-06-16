import { ApiProperty } from '@nestjs/swagger';
import type { PageInfo, WarehouseListView, WarehouseView } from '@b2b/contracts';

/**
 * Swagger RESPONSE models (TASK-012).
 *
 * The controller's return types are the `@b2b/contracts` INTERFACES, which carry
 * no runtime metadata, so generated OpenAPI response bodies would be empty. These
 * decorated classes exist ONLY to give Swagger a concrete schema; each `implements`
 * its contract interface so the documented shape can never drift from the wire
 * shape (a field rename/removal breaks the build). They are never instantiated —
 * the service still returns plain objects mapped by `toWarehouseView`, so the
 * runtime response is unchanged.
 */
export class WarehouseResponse implements WarehouseView {
  @ApiProperty({ format: 'uuid', description: 'Public warehouse id (UUID).' })
  id!: string;

  @ApiProperty({ example: 'MAIN' })
  code!: string;

  @ApiProperty({ example: 'Main Warehouse' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: '123 Example St.' })
  addressLine1!: string | null;

  @ApiProperty({ type: String, nullable: true })
  addressLine2!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Istanbul' })
  city!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '34000' })
  postalCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'TR' })
  country!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class WarehousePageInfoResponse implements PageInfo {
  @ApiProperty({ type: String, nullable: true, description: 'Cursor for the next page, or null.' })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasNextPage!: boolean;
}

export class WarehouseListResponse implements WarehouseListView {
  @ApiProperty({ type: [WarehouseResponse] })
  data!: WarehouseResponse[];

  @ApiProperty({ type: WarehousePageInfoResponse })
  pageInfo!: WarehousePageInfoResponse;
}
