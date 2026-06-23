import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveReturn, createReturn, getReturn, listReturns } from '../src/lib/returns-client';
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

describe('returns-client', () => {
  it('lists via apiFetch with credentials:"include", bearer token and status filter', async () => {
    const fn = okJson({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } });

    await listReturns({ status: 'DRAFT', cursor: 'cur-1' });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/returns?cursor=cur-1&status=DRAFT');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('gets one return by id with the bearer token', async () => {
    const fn = okJson({ id: 'ret-1' });

    await getReturn('ret-1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/returns/ret-1');
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('creates a return via POST orders/:id/returns with the Idempotency-Key header', async () => {
    const fn = okJson({ id: 'ret-1', returnNo: 'RET-1' }, 201);

    await createReturn(
      'ord-1',
      { items: [{ productId: 'p1', quantity: '2', reason: 'damaged' }], reason: null },
      'idem-create-1',
    );

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/orders/ord-1/returns');
    expect(init?.method).toBe('POST');
    expect(init).toMatchObject({ credentials: 'include' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('idem-create-1');
    expect(headers.authorization).toBe('Bearer tok-123');
    // Only product/quantity/reason are sent — no companyId/warehouse/price/total.
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      items: [{ productId: 'p1', quantity: '2', reason: 'damaged' }],
      reason: null,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /companyId|warehouseId|price|subtotal|total|tax|status/i,
    );
  });

  it('approves a return via POST returns/:id/approve with the Idempotency-Key header and no body', async () => {
    const fn = okJson({ id: 'ret-1', status: 'APPROVED' });

    await approveReturn('ret-1', 'idem-approve-1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/returns/ret-1/approve');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('idem-approve-1');
    // No client body — restock is server-resolved from the return lines.
    expect(init?.body).toBeUndefined();
  });
});
