import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI coverage for the product import/export endpoints (Product Import/Export
 * Foundation). Proves the generated document carries the import request body, the
 * import response schema, the import status/detail response, and the export
 * response — none empty.
 */
describe('Product import/export OpenAPI schemas', () => {
  let ctx: TestApp;
  let doc: OpenAPIObject;

  beforeAll(async () => {
    ctx = await createTestApp();
    doc = buildOpenApiDocument(ctx.app);
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const op = (path: string, method: 'get' | 'post') =>
    (doc.paths[path] as Record<string, Record<string, unknown>> | undefined)?.[method];

  it('documents POST /products/imports as a multipart request', () => {
    const post = op('/api/v1/products/imports', 'post') as
      | { requestBody?: { content?: Record<string, unknown> } }
      | undefined;
    expect(post).toBeDefined();
    expect(post?.requestBody?.content).toHaveProperty('multipart/form-data');
  });

  it('emits a non-empty import (201) response referencing ProductImportResponse', () => {
    const post = op('/api/v1/products/imports', 'post') as {
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    };
    const schema = post.responses?.['201']?.content?.['application/json']?.schema;
    expect(schema?.$ref).toBe('#/components/schemas/ProductImportResponse');
  });

  it('emits a non-empty import status/detail (200) response', () => {
    const get = op('/api/v1/products/imports/{id}', 'get') as {
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    };
    const schema = get.responses?.['200']?.content?.['application/json']?.schema;
    expect(schema?.$ref).toBe('#/components/schemas/ProductImportResponse');
  });

  it('documents GET /products/export with a CSV (200) response', () => {
    const get = op('/api/v1/products/export', 'get') as {
      responses?: Record<string, unknown>;
    };
    expect(get).toBeDefined();
    expect(get.responses).toHaveProperty('200');
  });

  it('documents the ProductImportResponse fields (incl. nested errors)', () => {
    const schemas = (doc.components?.schemas ?? {}) as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    const model = schemas.ProductImportResponse;
    expect(model).toBeDefined();
    for (const field of [
      'id',
      'status',
      'checksum',
      'totalRows',
      'validRows',
      'invalidRows',
      'appliedRows',
      'errors',
      'createdAt',
    ]) {
      expect(model?.properties, `ProductImportResponse.${field}`).toHaveProperty(field);
    }
    expect(schemas.ProductImportErrorResponse).toBeDefined();
    expect(schemas.ProductImportErrorResponse?.properties).toHaveProperty('row');
    expect(schemas.ProductImportErrorResponse?.properties).toHaveProperty('column');
  });
});
