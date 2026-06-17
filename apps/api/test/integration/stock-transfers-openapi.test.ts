import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Stock Transfer Foundation. The contract
 * return types are interfaces with no runtime metadata, so the controller
 * documents responses with explicit `@Api*Response({ type })` model classes. This
 * suite proves the generated document carries NON-EMPTY response schemas and the
 * expected fields for transfer create/list/detail.
 */
describe('Stock transfer OpenAPI response schemas', () => {
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

  it('emits a non-empty transfer create (201) response schema referencing StockTransferResponse', () => {
    const schema = successSchema('/api/v1/stock/transfers', 'post');
    expect(schema?.$ref).toBe('#/components/schemas/StockTransferResponse');
  });

  it('emits a non-empty transfer list (200) response schema referencing StockTransferListResponse', () => {
    const schema = successSchema('/api/v1/stock/transfers', 'get');
    expect(schema?.$ref).toBe('#/components/schemas/StockTransferListResponse');
  });

  it('emits a non-empty transfer detail (200) response schema referencing StockTransferResponse', () => {
    const schema = successSchema('/api/v1/stock/transfers/{id}', 'get');
    expect(schema?.$ref).toBe('#/components/schemas/StockTransferResponse');
  });

  it('documents the StockTransferResponse fields', () => {
    const props = schemas().StockTransferResponse?.properties ?? {};
    for (const field of [
      'id',
      'fromWarehouseId',
      'toWarehouseId',
      'productId',
      'sku',
      'name',
      'quantity',
      'reason',
      'createdAt',
    ]) {
      expect(props, `StockTransferResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the paginated transfer list shape (data + pageInfo)', () => {
    const list = schemas().StockTransferListResponse;
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');
  });
});
