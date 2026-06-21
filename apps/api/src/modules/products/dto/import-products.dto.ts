import { ApiProperty } from '@nestjs/swagger';

/**
 * Multipart body for `POST /products/imports`. The ONLY payload is the uploaded
 * file (consumed by the FileInterceptor, not validated here). This class is
 * deliberately empty so the global strict ValidationPipe (`forbidNonWhitelisted`)
 * rejects ANY extra multipart text field — in particular a forged `companyId`,
 * which a client may never supply (the tenant is the PostgreSQL principal).
 */
export class ImportProductsDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'CSV file. Required columns: sku, name, currency, listPriceAmount, taxRateBp.',
  })
  file?: unknown;
}
