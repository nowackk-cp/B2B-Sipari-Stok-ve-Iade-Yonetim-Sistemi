import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for warehouse management (TASK-012). The
 * contract return types are interfaces with no runtime metadata, so the
 * controller documents responses with explicit `@Api*Response({ type })` model
 * classes. This suite proves the generated document carries NON-EMPTY response
 * schemas and the expected fields.
 */
describe('Warehouses OpenAPI response schemas', () => {
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

  function successSchema(path: string, method: 'get' | 'post' | 'patch'): unknown {
    const op = (doc.paths[path] as Record<string, { responses?: Record<string, unknown> }>)[method];
    const responses = op?.responses ?? {};
    const success = (responses['200'] ?? responses['201']) as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined;
    return success?.content?.['application/json']?.schema;
  }

  it('emits a non-empty create (201) response schema referencing WarehouseResponse', () => {
    const schema = successSchema('/api/v1/warehouses', 'post') as { $ref?: string };
    expect(schema).toBeDefined();
    expect(schema.$ref).toBe('#/components/schemas/WarehouseResponse');
  });

  it('emits a non-empty get-one (200) response schema referencing WarehouseResponse', () => {
    const schema = successSchema('/api/v1/warehouses/{id}', 'get') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/WarehouseResponse');
  });

  it('emits a non-empty update (200) response schema referencing WarehouseResponse', () => {
    const schema = successSchema('/api/v1/warehouses/{id}', 'patch') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/WarehouseResponse');
  });

  it('emits a non-empty list (200) response schema referencing WarehouseListResponse', () => {
    const schema = successSchema('/api/v1/warehouses', 'get') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/WarehouseListResponse');
  });

  it('documents the WarehouseResponse fields', () => {
    const warehouse = schemas().WarehouseResponse;
    expect(warehouse).toBeDefined();
    const props = warehouse?.properties ?? {};
    for (const field of [
      'id',
      'code',
      'name',
      'addressLine1',
      'addressLine2',
      'city',
      'postalCode',
      'country',
      'isActive',
      'createdAt',
      'updatedAt',
    ]) {
      expect(props, `WarehouseResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the paginated list shape (data + pageInfo)', () => {
    const list = schemas().WarehouseListResponse;
    expect(list).toBeDefined();
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');

    const pageInfo = schemas().WarehousePageInfoResponse;
    expect(pageInfo).toBeDefined();
    expect(pageInfo?.properties).toHaveProperty('nextCursor');
    expect(pageInfo?.properties).toHaveProperty('hasNextPage');
  });
});
