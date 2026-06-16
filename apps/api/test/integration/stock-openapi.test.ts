import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Stock Ledger Foundation. The contract
 * return types are interfaces with no runtime metadata, so the controller
 * documents responses with explicit `@Api*Response({ type })` model classes. This
 * suite proves the generated document carries NON-EMPTY response schemas and the
 * expected fields for adjustments, balances and movements.
 */
describe('Stock OpenAPI response schemas', () => {
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

  it('emits a non-empty adjustment (201) response schema referencing StockMovementResponse', () => {
    const schema = successSchema('/api/v1/stock/adjustments', 'post');
    expect(schema).toBeDefined();
    expect(schema?.$ref).toBe('#/components/schemas/StockMovementResponse');
  });

  it('emits a non-empty balances list (200) response schema referencing StockBalanceListResponse', () => {
    const schema = successSchema('/api/v1/stock/balances', 'get');
    expect(schema?.$ref).toBe('#/components/schemas/StockBalanceListResponse');
  });

  it('emits a non-empty movements list (200) response schema referencing StockMovementListResponse', () => {
    const schema = successSchema('/api/v1/stock/movements', 'get');
    expect(schema?.$ref).toBe('#/components/schemas/StockMovementListResponse');
  });

  it('documents the StockBalanceResponse fields', () => {
    const props = schemas().StockBalanceResponse?.properties ?? {};
    for (const field of [
      'warehouseId',
      'productId',
      'sku',
      'name',
      'quantity',
      'availableQuantity',
      'updatedAt',
    ]) {
      expect(props, `StockBalanceResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the StockMovementResponse fields', () => {
    const props = schemas().StockMovementResponse?.properties ?? {};
    for (const field of [
      'warehouseId',
      'productId',
      'sku',
      'name',
      'type',
      'direction',
      'quantity',
      'balanceBefore',
      'balanceAfter',
      'reason',
      'createdAt',
    ]) {
      expect(props, `StockMovementResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the paginated list shape (data + pageInfo)', () => {
    const list = schemas().StockBalanceListResponse;
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');

    const pageInfo = schemas().StockPageInfoResponse;
    expect(pageInfo?.properties).toHaveProperty('nextCursor');
    expect(pageInfo?.properties).toHaveProperty('hasNextPage');
  });
});
