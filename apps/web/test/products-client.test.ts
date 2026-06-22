import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProduct,
  exportProducts,
  filenameFromDisposition,
  importProducts,
  listProducts,
} from '../src/lib/products-client';
import { setAccessToken } from '../src/lib/auth-client';

function mockFetch(body: BodyInit | null, init: ResponseInit) {
  const fn = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(body, init),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => setAccessToken('tok-123'));
afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('products-client', () => {
  it('lists via apiFetch with credentials:"include", bearer token and query string', async () => {
    const fn = mockFetch(
      JSON.stringify({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );

    await listProducts({ search: 'widget', isActive: 'true' });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/products?search=widget&isActive=true');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('creates with a JSON body and never sends companyId', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'p1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });

    await createProduct({
      sku: 'SKU-1',
      name: 'Widget',
      listPrice: { amount: '1000', currency: 'TRY' },
      vatRate: 2000,
      isActive: true,
    });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/products');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('companyId');
    expect(sent.sku).toBe('SKU-1');
  });

  it('imports a CSV as multipart FormData (no JSON content-type)', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'imp1', status: 'COMPLETED', appliedRows: 2 }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
    const file = new File(['sku,name\nA,B'], 'p.csv', { type: 'text/csv' });

    const result = await importProducts(file);

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/products/imports');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    // The browser sets the multipart content-type/boundary itself — we must not.
    expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(result.id).toBe('imp1');
  });

  it('exports a blob and reads the filename from Content-Disposition', async () => {
    mockFetch('sku,name\nA,B', {
      status: 200,
      headers: {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="products-20260101.csv"',
      },
    });

    const { blob, filename } = await exportProducts({ search: 'a' });

    expect(filename).toBe('products-20260101.csv');
    expect(await blob.text()).toContain('sku,name');
  });

  it('falls back to a default export filename when the header is missing', async () => {
    mockFetch('x', { status: 200, headers: { 'content-type': 'text/csv' } });

    const { filename } = await exportProducts();

    expect(filename).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe('filenameFromDisposition', () => {
  it('parses a quoted filename', () => {
    expect(filenameFromDisposition('attachment; filename="a b.csv"')).toBe('a b.csv');
  });
  it('parses an RFC 5987 filename*', () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''a%20b.csv")).toBe('a b.csv');
  });
  it('returns undefined for a missing header', () => {
    expect(filenameFromDisposition(null)).toBeUndefined();
  });
});
