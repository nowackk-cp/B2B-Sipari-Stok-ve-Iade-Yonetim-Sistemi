import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/bootstrap';
import { type TestApp, closeTestApp, createTestApp } from './helpers';

/**
 * OpenAPI response-schema coverage for the Dashboard / Reports Backend Foundation.
 * The contract return types are interfaces with no runtime metadata, so the
 * controllers document responses with explicit `@Api*Response({ type })` model
 * classes. This suite proves the generated document carries NON-EMPTY response
 * schemas and the expected fields for the dashboard summary and the three reports.
 */
describe('Dashboard / Reports OpenAPI response schemas', () => {
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

  function successSchema(path: string, method: 'get'): { $ref?: string } | undefined {
    const op = (doc.paths[path] as Record<string, { responses?: Record<string, unknown> }>)[method];
    const responses = op?.responses ?? {};
    const success = responses['200'] as
      | { content?: Record<string, { schema?: { $ref?: string } }> }
      | undefined;
    return success?.content?.['application/json']?.schema;
  }

  it('emits a non-empty dashboard summary (200) schema', () => {
    expect(successSchema('/api/v1/dashboard/summary', 'get')?.$ref).toBe(
      '#/components/schemas/DashboardSummaryResponse',
    );
  });

  it('emits non-empty sales / inventory / returns report (200) schemas', () => {
    expect(successSchema('/api/v1/reports/sales', 'get')?.$ref).toBe(
      '#/components/schemas/SalesReportResponse',
    );
    expect(successSchema('/api/v1/reports/inventory', 'get')?.$ref).toBe(
      '#/components/schemas/InventoryReportResponse',
    );
    expect(successSchema('/api/v1/reports/returns', 'get')?.$ref).toBe(
      '#/components/schemas/ReturnsReportResponse',
    );
  });

  it('documents the DashboardSummaryResponse fields', () => {
    const props = schemas().DashboardSummaryResponse?.properties ?? {};
    for (const field of [
      'totalProducts',
      'activeProducts',
      'totalCustomers',
      'lowStockProducts',
      'draftOrders',
      'approvedOrders',
      'shippedOrders',
      'issuedInvoices',
      'requestedReturns',
      'approvedReturns',
      'todaySalesAmount',
      'monthSalesAmount',
    ]) {
      expect(props, `DashboardSummaryResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the SalesReportResponse + row fields', () => {
    expect(schemas().SalesReportResponse?.properties).toHaveProperty('rows');
    const row = schemas().SalesReportRowResponse?.properties ?? {};
    for (const field of [
      'period',
      'invoiceCount',
      'subtotalAmount',
      'vatAmount',
      'totalAmount',
      'currency',
    ]) {
      expect(row, `SalesReportRowResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the InventoryReportResponse (data + pageInfo) + row fields', () => {
    const list = schemas().InventoryReportResponse;
    expect(list?.properties).toHaveProperty('data');
    expect(list?.properties).toHaveProperty('pageInfo');
    const row = schemas().InventoryReportRowResponse?.properties ?? {};
    for (const field of [
      'productId',
      'sku',
      'name',
      'warehouseId',
      'onHand',
      'reserved',
      'available',
      'criticalStockThreshold',
      'isLowStock',
    ]) {
      expect(row, `InventoryReportRowResponse.${field}`).toHaveProperty(field);
    }
  });

  it('documents the ReturnsReportResponse fields', () => {
    const props = schemas().ReturnsReportResponse?.properties ?? {};
    for (const field of [
      'returnCount',
      'requestedCount',
      'approvedCount',
      'totalReturnedQuantity',
      'creditNoteCount',
      'creditNoteTotalAmount',
    ]) {
      expect(props, `ReturnsReportResponse.${field}`).toHaveProperty(field);
    }
  });
});
