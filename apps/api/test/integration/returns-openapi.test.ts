import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Return/Refund Foundation. The contract
 * return types are interfaces with no runtime metadata, so the controller documents
 * responses with explicit `@Api*Response({ type })` model classes. This suite proves
 * the generated document carries NON-EMPTY response schemas and the expected fields
 * for return create/list/detail/approve.
 */
describe('Return OpenAPI response schemas', () => {
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

  it('emits a non-empty return create (201) schema referencing ReturnResponse', () => {
    expect(successSchema('/api/v1/orders/{id}/returns', 'post')?.$ref).toBe(
      '#/components/schemas/ReturnResponse',
    );
  });

  it('emits a non-empty return list (200) schema referencing ReturnListResponse', () => {
    expect(successSchema('/api/v1/returns', 'get')?.$ref).toBe(
      '#/components/schemas/ReturnListResponse',
    );
  });

  it('emits a non-empty return detail (200) schema referencing ReturnResponse', () => {
    expect(successSchema('/api/v1/returns/{id}', 'get')?.$ref).toBe(
      '#/components/schemas/ReturnResponse',
    );
  });

  it('emits a non-empty return approve (200) schema referencing ReturnResponse', () => {
    expect(successSchema('/api/v1/returns/{id}/approve', 'post')?.$ref).toBe(
      '#/components/schemas/ReturnResponse',
    );
  });

  it('documents the ReturnResponse fields (including nested items)', () => {
    const props = schemas().ReturnResponse?.properties ?? {};
    for (const field of [
      'id',
      'returnNo',
      'status',
      'orderId',
      'customerId',
      'warehouseId',
      'invoiceId',
      'reason',
      'items',
      'createdAt',
      'approvedAt',
    ]) {
      expect(props, `ReturnResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the ReturnItemResponse fields', () => {
    const props = schemas().ReturnItemResponse?.properties ?? {};
    for (const field of ['productId', 'quantity', 'reason']) {
      expect(props, `ReturnItemResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the paginated return list shape (data + pageInfo)', () => {
    const list = schemas().ReturnListResponse;
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');
  });
});
