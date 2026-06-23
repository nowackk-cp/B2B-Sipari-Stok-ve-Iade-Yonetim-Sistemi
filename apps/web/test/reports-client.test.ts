import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchInventoryReport,
  fetchReturnsReport,
  fetchSalesReport,
} from '../src/lib/reports-client';
import { ApiError } from '../src/lib/api-fetch';
import { setAccessToken } from '../src/lib/auth-client';

function mockFetch(body: BodyInit | null, init: ResponseInit) {
  const fn = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(body, init),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const okJson = (body: unknown, status = 200) =>
  mockFetch(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => setAccessToken('tok-123'));
afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('reports-client', () => {
  it('fetches the sales report via apiFetch with credentials:"include" and the bearer token', async () => {
    const fn = okJson({ groupBy: 'day', dateFrom: '2026-06-01', dateTo: '2026-06-30', rows: [] });

    await fetchSalesReport({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      groupBy: 'month',
      warehouseId: 'wh-1',
    });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://api.test/api/v1/reports/sales?dateFrom=2026-06-01&dateTo=2026-06-30&warehouseId=wh-1&groupBy=month',
    );
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('omits optional sales params that are not set (only contract keys are sent)', async () => {
    const fn = okJson({ groupBy: 'day', dateFrom: '2026-06-01', dateTo: '2026-06-30', rows: [] });

    await fetchSalesReport({ dateFrom: '2026-06-01', dateTo: '2026-06-30' });

    const [url] = fn.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://api.test/api/v1/reports/sales?dateFrom=2026-06-01&dateTo=2026-06-30',
    );
    // No warehouseId/groupBy keys, and never a tenant claim.
    expect(String(url)).not.toMatch(/warehouseId|groupBy|companyId|tenant/i);
  });

  it('fetches the inventory report, forwarding only whitelisted query keys', async () => {
    const fn = okJson({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } });

    await fetchInventoryReport({
      search: 'widget',
      lowStockOnly: true,
      warehouseId: 'wh-9',
      cursor: 'cur-1',
      limit: 50,
    });

    const [url, init] = fn.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/v1/reports/inventory');
    expect(parsed.searchParams.get('search')).toBe('widget');
    expect(parsed.searchParams.get('lowStockOnly')).toBe('true');
    expect(parsed.searchParams.get('warehouseId')).toBe('wh-9');
    expect(parsed.searchParams.get('cursor')).toBe('cur-1');
    expect(parsed.searchParams.get('limit')).toBe('50');
    expect(parsed.searchParams.get('companyId')).toBeNull();
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('drops lowStockOnly from the inventory query when the flag is off', async () => {
    const fn = okJson({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } });

    await fetchInventoryReport({ lowStockOnly: false });

    const [url] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/reports/inventory');
  });

  it('fetches the returns report with date/status/warehouse params', async () => {
    const fn = okJson({
      returnCount: 0,
      requestedCount: 0,
      approvedCount: 0,
      totalReturnedQuantity: '0',
      creditNoteCount: 0,
      creditNoteTotalAmount: [],
    });

    await fetchReturnsReport({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      status: 'APPROVED',
      warehouseId: 'wh-2',
    });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://api.test/api/v1/reports/returns?dateFrom=2026-06-01&dateTo=2026-06-30&warehouseId=wh-2&status=APPROVED',
    );
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('parses an RFC 7807 problem+json error body into an ApiError', async () => {
    mockFetch(
      JSON.stringify({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'dateFrom must be a valid ISO date',
      }),
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    );

    await expect(
      fetchSalesReport({ dateFrom: 'nope', dateTo: '2026-06-30' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('surfaces the parsed problem as an ApiError instance', async () => {
    mockFetch(JSON.stringify({ title: 'Forbidden', status: 403, code: 'FORBIDDEN' }), {
      status: 403,
      headers: { 'content-type': 'application/problem+json' },
    });

    const err = await fetchReturnsReport({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).problem?.detail).toBeUndefined();
    expect((err as ApiError).code).toBe('FORBIDDEN');
  });
});
