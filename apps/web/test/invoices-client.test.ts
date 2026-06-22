import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getInvoice,
  issueInvoiceForOrder,
  listInvoices,
} from '../src/lib/invoices-client';
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

describe('invoices-client', () => {
  it('lists via apiFetch with credentials:"include", bearer token and status filter', async () => {
    const fn = mockFetch(
      JSON.stringify({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    await listInvoices({ status: 'ISSUED', cursor: 'cur-1' });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/invoices?cursor=cur-1&status=ISSUED');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('gets one invoice by id with the bearer token', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'inv-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await getInvoice('inv-1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/invoices/inv-1');
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('issues an invoice via POST orders/:id/invoice with the Idempotency-Key header', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'inv-1', invoiceNo: 'INV-2026-000001' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });

    await issueInvoiceForOrder('o1', 'idem-key-xyz');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders/o1/invoice');
    expect(init?.method).toBe('POST');
    expect(init).toMatchObject({ credentials: 'include' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('idem-key-xyz');
    expect(headers.authorization).toBe('Bearer tok-123');
    // No client body — totals/number are server-resolved from the order.
    expect(init?.body).toBeUndefined();
  });
});
