import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Customer management API (Customer
 * Management Foundation). The contract return types are interfaces with no
 * runtime metadata, so the controller documents responses with explicit
 * `@Api*Response({ type })` model classes. This suite proves the generated
 * document carries NON-EMPTY response schemas and the expected fields.
 */
describe('Customers OpenAPI response schemas', () => {
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

  it('emits a non-empty create (201) response schema referencing CustomerResponse', () => {
    const schema = successSchema('/api/v1/customers', 'post') as { $ref?: string };
    expect(schema).toBeDefined();
    expect(schema.$ref).toBe('#/components/schemas/CustomerResponse');
  });

  it('emits a non-empty get-one (200) response schema referencing CustomerResponse', () => {
    const schema = successSchema('/api/v1/customers/{id}', 'get') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/CustomerResponse');
  });

  it('emits a non-empty update (200) response schema referencing CustomerResponse', () => {
    const schema = successSchema('/api/v1/customers/{id}', 'patch') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/CustomerResponse');
  });

  it('emits a non-empty list (200) response schema referencing CustomerListResponse', () => {
    const schema = successSchema('/api/v1/customers', 'get') as { $ref?: string };
    expect(schema?.$ref).toBe('#/components/schemas/CustomerListResponse');
  });

  it('documents the delete (204) no-content response', () => {
    const op = (
      doc.paths['/api/v1/customers/{id}'] as Record<string, { responses?: Record<string, unknown> }>
    ).delete;
    expect(op?.responses).toHaveProperty('204');
  });

  it('documents the CustomerResponse fields', () => {
    const customer = schemas().CustomerResponse;
    expect(customer).toBeDefined();
    const props = customer?.properties ?? {};
    for (const field of [
      'id',
      'code',
      'name',
      'type',
      'taxNumber',
      'email',
      'phone',
      'createdAt',
      'updatedAt',
    ]) {
      expect(props, `CustomerResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the paginated list shape (data + pageInfo)', () => {
    const list = schemas().CustomerListResponse;
    expect(list).toBeDefined();
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');

    const pageInfo = schemas().CustomerPageInfoResponse;
    expect(pageInfo).toBeDefined();
    expect(pageInfo?.properties).toHaveProperty('nextCursor');
    expect(pageInfo?.properties).toHaveProperty('hasNextPage');
  });
});
