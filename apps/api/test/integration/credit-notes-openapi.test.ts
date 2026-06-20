import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Return Invoice / Credit Note Foundation.
 * The contract return types are interfaces with no runtime metadata, so the
 * controller documents responses with explicit `@Api*Response({ type })` model
 * classes. This suite proves the generated document carries NON-EMPTY response
 * schemas and the expected fields for credit note create/list/detail.
 */
describe('Credit note OpenAPI response schemas', () => {
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

  it('emits a non-empty credit note create (201) schema referencing CreditNoteResponse', () => {
    expect(successSchema('/api/v1/returns/{id}/credit-note', 'post')?.$ref).toBe(
      '#/components/schemas/CreditNoteResponse',
    );
  });

  it('emits a non-empty credit note list (200) schema referencing CreditNoteListResponse', () => {
    expect(successSchema('/api/v1/credit-notes', 'get')?.$ref).toBe(
      '#/components/schemas/CreditNoteListResponse',
    );
  });

  it('emits a non-empty credit note detail (200) schema referencing CreditNoteResponse', () => {
    expect(successSchema('/api/v1/credit-notes/{id}', 'get')?.$ref).toBe(
      '#/components/schemas/CreditNoteResponse',
    );
  });

  it('documents the CreditNoteResponse fields (including nested items)', () => {
    const props = schemas().CreditNoteResponse?.properties ?? {};
    for (const field of [
      'id',
      'creditNoteNo',
      'creditNoteNumber',
      'seriesCode',
      'fiscalYear',
      'status',
      'returnId',
      'orderId',
      'originalInvoiceId',
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
      expect(props, `CreditNoteResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the CreditNoteItemResponse fields', () => {
    const props = schemas().CreditNoteItemResponse?.properties ?? {};
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
      expect(props, `CreditNoteItemResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the paginated credit note list shape (data + pageInfo)', () => {
    const list = schemas().CreditNoteListResponse;
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');
  });
});
