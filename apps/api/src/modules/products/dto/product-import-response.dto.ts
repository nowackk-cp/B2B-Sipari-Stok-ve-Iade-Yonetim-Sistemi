import { ApiProperty } from '@nestjs/swagger';
import type {
  ProductImportErrorView,
  ProductImportResultView,
  ProductImportStatus,
} from '@b2b/contracts';

/**
 * Swagger RESPONSE models for product import (mirrors the catalog pattern). The
 * controller returns the `@b2b/contracts` interfaces, which carry no runtime
 * metadata, so these decorated classes exist ONLY to give Swagger a concrete,
 * non-empty schema. Each `implements` its contract interface so the documented
 * shape can never drift from the wire shape.
 */
export class ProductImportErrorResponse implements ProductImportErrorView {
  @ApiProperty({ example: 3, description: '1-based data-row number (header is row 0).' })
  row!: number;

  @ApiProperty({ type: String, nullable: true, example: 'listPriceAmount' })
  column!: string | null;

  @ApiProperty({ example: 'listPriceAmount must be a non-negative integer within bigint range.' })
  message!: string;
}

export class ProductImportResponse implements ProductImportResultView {
  @ApiProperty({ format: 'uuid', description: 'Public import id (the source file UUID).' })
  id!: string;

  @ApiProperty({ enum: ['COMPLETED', 'VALIDATION_FAILED'], example: 'COMPLETED' })
  status!: ProductImportStatus;

  @ApiProperty({ example: 'e3b0c44298fc1c149afbf4c8996fb924...', description: 'SHA-256 hex.' })
  checksum!: string;

  @ApiProperty({ example: 10 })
  totalRows!: number;

  @ApiProperty({ example: 10 })
  validRows!: number;

  @ApiProperty({ example: 0 })
  invalidRows!: number;

  @ApiProperty({ example: 10 })
  appliedRows!: number;

  @ApiProperty({ type: [ProductImportErrorResponse] })
  errors!: ProductImportErrorResponse[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
