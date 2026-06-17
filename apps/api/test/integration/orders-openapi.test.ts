import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Order Draft Foundation. The contract
 * return types are interfaces with no runtime metadata, so the controller documents
 * responses with explicit `@Api*Response({ type })` model classes. This suite proves
 * the generated document carries NON-EMPTY response schemas and the expected fields
 * for order create/list/detail/update/cancel.
 */
describe('Order OpenAPI response schemas', () => {
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

  function successSchema(
    path: string,
    method: 'get' | 'post' | 'patch',
  ): { $ref?: string } | undefined {
    const op = (doc.paths[path] as Record<string, { responses?: Record<string, unknown> }>)[method];
    const responses = op?.responses ?? {};
    const success = (responses['200'] ?? responses['201']) as
      | { content?: Record<string, { schema?: { $ref?: string } }> }
      | undefined;
    return success?.content?.['application/json']?.schema;
  }

  it('emits a non-empty order create (201) schema referencing OrderResponse', () => {
    expect(successSchema('/api/v1/orders', 'post')?.$ref).toBe(
      '#/components/schemas/OrderResponse',
    );
  });

  it('emits a non-empty order list (200) schema referencing OrderListResponse', () => {
    expect(successSchema('/api/v1/orders', 'get')?.$ref).toBe(
      '#/components/schemas/OrderListResponse',
    );
  });

  it('emits a non-empty order detail (200) schema referencing OrderResponse', () => {
    expect(successSchema('/api/v1/orders/{id}', 'get')?.$ref).toBe(
      '#/components/schemas/OrderResponse',
    );
  });

  it('emits a non-empty order update (200) schema referencing OrderResponse', () => {
    expect(successSchema('/api/v1/orders/{id}', 'patch')?.$ref).toBe(
      '#/components/schemas/OrderResponse',
    );
  });

  it('emits a non-empty order cancel (200) schema referencing OrderResponse', () => {
    expect(successSchema('/api/v1/orders/{id}/cancel', 'post')?.$ref).toBe(
      '#/components/schemas/OrderResponse',
    );
  });

  it('emits a non-empty order approve (200) schema referencing OrderResponse', () => {
    expect(successSchema('/api/v1/orders/{id}/approve', 'post')?.$ref).toBe(
      '#/components/schemas/OrderResponse',
    );
  });

  it('documents the OrderResponse fields (including nested items)', () => {
    const props = schemas().OrderResponse?.properties ?? {};
    for (const field of [
      'id',
      'orderNo',
      'customerId',
      'warehouseId',
      'status',
      'currency',
      'subtotal',
      'vat',
      'total',
      'note',
      'items',
      'createdAt',
      'updatedAt',
      'approvedAt',
      'cancelledAt',
    ]) {
      expect(props, `OrderResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the OrderItemResponse fields', () => {
    const props = schemas().OrderItemResponse?.properties ?? {};
    for (const field of [
      'productId',
      'sku',
      'name',
      'quantity',
      'unitPrice',
      'vatRate',
      'lineSubtotal',
      'lineVat',
      'lineTotal',
    ]) {
      expect(props, `OrderItemResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the paginated order list shape (data + pageInfo)', () => {
    const list = schemas().OrderListResponse;
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');
  });
});
