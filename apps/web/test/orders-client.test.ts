import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveOrder,
  cancelOrder,
  createOrder,
  getOrder,
  listOrders,
  shipOrder,
  updateOrder,
} from '../src/lib/orders-client';
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

describe('orders-client', () => {
  it('lists via apiFetch with credentials:"include", bearer token and status filter', async () => {
    const fn = mockFetch(
      JSON.stringify({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    await listOrders({ status: 'DRAFT', cursor: 'cur-1' });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders?cursor=cur-1&status=DRAFT');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('gets one order by id with the bearer token', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'o1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await getOrder('o1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders/o1');
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('creates with a JSON body and never sends companyId/price/total fields', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'o1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });

    await createOrder({
      customerId: 'cust-1',
      warehouseId: 'wh-1',
      items: [{ productId: 'p1', quantity: '3' }],
      note: 'rush',
    });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('companyId');
    expect(sent).not.toHaveProperty('unitPrice');
    expect(sent).not.toHaveProperty('vatRate');
    expect(sent).not.toHaveProperty('total');
    expect(sent.customerId).toBe('cust-1');
    expect(sent.items).toEqual([{ productId: 'p1', quantity: '3' }]);
  });

  it('updates an order by id without sending companyId/price/total fields', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'o1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await updateOrder('o1', { items: [{ productId: 'p1', quantity: '5' }] });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders/o1');
    expect(init?.method).toBe('PATCH');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('companyId');
    expect(sent).not.toHaveProperty('total');
    expect(sent.items).toEqual([{ productId: 'p1', quantity: '5' }]);
  });

  it('cancels via POST :id/cancel with the reason in the body', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'o1', status: 'CANCELLED' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await cancelOrder('o1', 'changed mind');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders/o1/cancel');
    expect(init?.method).toBe('POST');
    expect(init).toMatchObject({ credentials: 'include' });
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent.reason).toBe('changed mind');
  });

  it('approves via POST :id/approve with the bearer token and NO idempotency key', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'o1', status: 'APPROVED' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await approveOrder('o1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders/o1/approve');
    expect(init?.method).toBe('POST');
    expect(init).toMatchObject({ credentials: 'include' });
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-123');
    expect(headers['idempotency-key']).toBeUndefined();
    // No client body — totals/status are server-resolved.
    expect(init?.body).toBeUndefined();
  });

  it('ships via POST :id/ship sending the Idempotency-Key header (no body)', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'o1', status: 'SHIPPED' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await shipOrder('o1', 'idem-key-123');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders/o1/ship');
    expect(init?.method).toBe('POST');
    expect(init).toMatchObject({ credentials: 'include' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('idem-key-123');
    expect(headers.authorization).toBe('Bearer tok-123');
    expect(init?.body).toBeUndefined();
  });
});
