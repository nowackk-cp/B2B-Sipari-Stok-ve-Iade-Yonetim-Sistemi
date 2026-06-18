import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Invoice/Billing Foundation. The
 * contract return types are interfaces with no runtime metadata, so the controller
 * documents responses with explicit `@Api*Response({ type })` model classes. This
 * suite proves the generated document carries NON-EMPTY response schemas and the
 * expected fields for invoice create/list/detail.
 */
describe('Invoice OpenAPI response schemas', () => {
  let ctx: TestApp;
  let doc: OpenAPIObject;

  beforeAll(async () => {
    ctx = await createTestApp();
    doc = buildOpenApiDocument(ctx.app);
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const schemas = (): Record<string, { properties?: Record<string, unknown> }> =>
    (doc.components?.schemas ?? {}) as Record<string, { properties?: Record<string, unknown> }>;

  function successSchema(path: string, method: 'get' | 'post'): { $ref?: string } | undefined {
    const op = (doc.paths[path] as Record<string, { responses?: Record<string, unknown> }>)[method];
    const responses = op?.responses ?? {};
    const success = (responses['200'] ?? responses['201']) as
      | { content?: Record<string, { schema?: { $ref?: string } }> }
      | undefined;
    return success?.content?.['application/json']?.schema;
  }

  it('emits a non-empty invoice create (201) schema referencing InvoiceResponse', () => {
    expect(successSchema('/api/v1/orders/{id}/invoice', 'post')?.$ref).toBe(
      '#/components/schemas/InvoiceResponse',
    );
  });

  it('emits a non-empty invoice list (200) schema referencing InvoiceListResponse', () => {
    expect(successSchema('/api/v1/invoices', 'get')?.$ref).toBe(
      '#/components/schemas/InvoiceListResponse',
    );
  });

  it('emits a non-empty invoice detail (200) schema referencing InvoiceResponse', () => {
    expect(successSchema('/api/v1/invoices/{id}', 'get')?.$ref).toBe(
      '#/components/schemas/InvoiceResponse',
    );
  });

  it('documents the InvoiceResponse fields (including nested items)', () => {
    const props = schemas().InvoiceResponse?.properties ?? {};
    for (const field of [
      'id',
      'invoiceNo',
      'invoiceNumber',
      'seriesCode',
      'fiscalYear',
      'status',
      'orderId',
      'customerId',
      'warehouseId',
      'currency',
      'subtotal',
      'vat',
      'total',
      'items',
      'issuedAt',
      'createdAt',
    ]) {
      expect(props, `InvoiceResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the InvoiceItemResponse fields', () => {
    const props = schemas().InvoiceItemResponse?.properties ?? {};
    for (const field of [
      'productId',
      'description',
      'quantity',
      'unitPrice',
      'vatRate',
      'lineSubtotal',
      'lineVat',
      'lineTotal',
    ]) {
      expect(props, `InvoiceItemResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the paginated invoice list shape (data + pageInfo)', () => {
    const list = schemas().InvoiceListResponse;
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');
  });
});
