import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { ProductImportResultView, ProductListView, ProductView } from '@b2b/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { requestMeta } from '../../common/http/request-meta';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQuery } from './dto/list-products.query';
import { ProductListResponse, ProductResponse } from './dto/product-response.dto';
import { ImportProductsDto } from './dto/import-products.dto';
import { ExportProductsQuery } from './dto/export-products.query';
import { ProductImportResponse } from './dto/product-import-response.dto';
import { ProductImportService, type UploadedCsvFile } from './import-export/product-import.service';
import { ProductExportService } from './import-export/product-export.service';

/** Upload guard: cap the import file at 5 MiB (a generous catalog CSV). */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

function parseBoolParam(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true';
}

/**
 * Product catalog REST surface (TASK-011).
 *
 * Authentication + authorization come from the GLOBAL guard chain bound in
 * AppModule (JwtAuthGuard → PermissionGuard) — this controller declares NO local
 * `@UseGuards`; it only attaches the required permission per route via
 * `@RequirePermissions`, so coverage cannot drift behind a forgotten local guard
 * (PERMISSION_MATRIX §3). The owning tenant is always the principal's real
 * company (DB-resolved), never the request body.
 *
 * Response schemas are documented with explicit `@Api*Response({ type })` models
 * (the contract interfaces carry no runtime metadata) so generated OpenAPI bodies
 * are non-empty; the runtime shape is unchanged (PRODUCT-CATALOG review BLOCKER 2).
 */
@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly imports: ProductImportService,
    private readonly exports: ProductExportService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('product:create')
  @ApiOperation({ summary: 'Create a product in the caller’s company.' })
  @ApiCreatedResponse({ type: ProductResponse, description: 'The created product.' })
  create(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateProductDto,
    @Req() req: Request,
  ): Promise<ProductView> {
    return this.products.create(principal, dto, requestMeta(req));
  }

  // NOTE: the static `imports`/`export` routes are declared BEFORE `@Get(':id')`
  // so Express does not match e.g. `/products/export` as a product id.

  @Post('imports')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('product:import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: ImportProductsDto })
  @ApiOperation({
    summary: 'Bulk-import products from a CSV file into the caller’s company (all-or-nothing).',
  })
  @ApiCreatedResponse({ type: ProductImportResponse, description: 'The completed import summary.' })
  importProducts(
    @CurrentUser() principal: AuthPrincipal,
    @UploadedFile() file: UploadedCsvFile | undefined,
    @Req() req: Request,
  ): Promise<ProductImportResultView> {
    // The multipart body must carry ONLY the file. Any text field (multer parses
    // them into `req.body`) is rejected — in particular a forged `companyId`, as
    // the tenant is always the PostgreSQL principal, never client-supplied.
    const extraFields = Object.keys((req.body ?? {}) as Record<string, unknown>);
    if (extraFields.length > 0) {
      throw new BadRequestException(
        `Unexpected form field(s): ${extraFields.join(', ')}. Only a "file" upload is accepted.`,
      );
    }
    return this.imports.import(principal, file, requestMeta(req));
  }

  @Get('export')
  @RequirePermissions('product:export')
  @Header('Cache-Control', 'no-store')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export the caller’s company catalog as a CSV file (active by default).',
  })
  @ApiOkResponse({ description: 'A CSV document (text/csv) of the matching products.' })
  async exportProducts(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ExportProductsQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const file = await this.exports.export(principal, {
      search: query.search?.trim() || undefined,
      isActive: parseBoolParam(query.isActive),
      categoryId: query.categoryId ? BigInt(query.categoryId) : undefined,
    });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return file.body;
  }

  @Get('imports/:id')
  @RequirePermissions('product:import')
  @ApiOperation({ summary: 'Get a previously-completed product import by id.' })
  @ApiOkResponse({ type: ProductImportResponse, description: 'The import summary.' })
  getImport(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<ProductImportResultView> {
    return this.imports.getOne(principal, id);
  }

  @Get()
  @RequirePermissions('product:read')
  @ApiOperation({ summary: 'List/search the caller’s company products (paginated).' })
  @ApiOkResponse({ type: ProductListResponse, description: 'A page of products.' })
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ListProductsQuery,
  ): Promise<ProductListView> {
    return this.products.list(principal, query);
  }

  @Get(':id')
  @RequirePermissions('product:read')
  @ApiOperation({ summary: 'Get one product by public id.' })
  @ApiOkResponse({ type: ProductResponse, description: 'The product.' })
  getOne(@CurrentUser() principal: AuthPrincipal, @Param('id') id: string): Promise<ProductView> {
    return this.products.getOne(principal, id);
  }

  @Patch(':id')
  @RequirePermissions('product:update')
  @ApiOperation({ summary: 'Update a product in the caller’s company.' })
  @ApiOkResponse({ type: ProductResponse, description: 'The updated product.' })
  update(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: Request,
  ): Promise<ProductView> {
    return this.products.update(principal, id, dto, requestMeta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('product:delete')
  @ApiOperation({ summary: 'Soft-delete a product in the caller’s company.' })
  @ApiNoContentResponse({ description: 'The product was soft-deleted (no content).' })
  remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.products.remove(principal, id, requestMeta(req));
  }
}
