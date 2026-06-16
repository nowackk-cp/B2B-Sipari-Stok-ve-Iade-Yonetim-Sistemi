import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Product catalog (PRODUCT-CATALOG
 * review BLOCKER 2). The contract return types are interfaces with no runtime
 * metadata, so the controller documents responses with explicit
 * `@Api*Response({ type })` model classes. This suite proves the generated
 * document carries NON-EMPTY response schemas and the expected fields.
 */
describe('Products OpenAPI response schemas', () => {
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

  /** The success-response JSON schema object for a path+method (or undefined). */
  function successSchema(path: string, method: 'get' | 'post' | 'patch'): unknown {
    const op = (doc.paths[path] as Record<string, { responses?: Record<string, unknown> }>)[method];
    const responses = op?.responses ?? {};
    const success = (responses['200'] ?? responses['201']) as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined;
    return success?.content?.['application/json']?.schema;
  }

  it('emits a non-empty create (201) response schema referencing ProductResponse', () => {
    const schema = successSchema('/api/v1/products', 'post') as { $ref?: string };
    expect(schema).toBeDefined();
    expect(schema.$ref).toBe('#/components/schemas/ProductResponse');
  });

  it('emits a non-empty get-one (200) response schema referencing ProductResponse', () => {
    const schema = successSchema('/api/v1/products/{id}', 'get') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/ProductResponse');
  });

  it('emits a non-empty update (200) response schema referencing ProductResponse', () => {
    const schema = successSchema('/api/v1/products/{id}', 'patch') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/ProductResponse');
  });

  it('emits a non-empty list (200) response schema referencing ProductListResponse', () => {
    const schema = successSchema('/api/v1/products', 'get') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/ProductListResponse');
  });

  it('documents the ProductResponse fields (incl. money + threshold)', () => {
    const product = schemas().ProductResponse;
    expect(product).toBeDefined();
    const props = product?.properties ?? {};
    for (const field of [
      'id',
      'sku',
      'name',
      'description',
      'barcode',
      'unit',
      'categoryId',
      'vatRate',
      'listPrice',
      'isActive',
      'criticalStockThreshold',
      'createdAt',
      'updatedAt',
    ]) {
      expect(props, `ProductResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the MoneyResponse fields', () => {
    const money = schemas().MoneyResponse;
    expect(money).toBeDefined();
    expect(money?.properties).toHaveProperty('amount');
    expect(money?.properties).toHaveProperty('currency');
  });

  it('documents the paginated list shape (data + pageInfo)', () => {
    const list = schemas().ProductListResponse;
    expect(list).toBeDefined();
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');

    const pageInfo = schemas().PageInfoResponse;
    expect(pageInfo).toBeDefined();
    expect(pageInfo?.properties).toHaveProperty('nextCursor');
    expect(pageInfo?.properties).toHaveProperty('hasNextPage');
  });
});
