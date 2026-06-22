import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWarehouse,
  deleteWarehouse,
  listWarehouses,
  updateWarehouse,
} from '../src/lib/warehouses-client';
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

describe('warehouses-client', () => {
  it('lists via apiFetch with credentials:"include", bearer token and query string', async () => {
    const fn = mockFetch(
      JSON.stringify({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    await listWarehouses({ search: 'main', isActive: 'true' });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/warehouses?search=main&isActive=true');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('creates with a JSON body and never sends companyId', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'w1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });

    await createWarehouse({
      code: 'MAIN',
      name: 'Main Warehouse',
      city: 'Istanbul',
      country: 'TR',
      isActive: true,
    });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/warehouses');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('companyId');
    expect(sent.code).toBe('MAIN');
  });

  it('updates a warehouse by id without sending companyId', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'w1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await updateWarehouse('w1', { name: 'Renamed' });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/warehouses/w1');
    expect(init?.method).toBe('PATCH');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('companyId');
    expect(sent.name).toBe('Renamed');
  });

  it('soft-deletes a warehouse via DELETE with the bearer token', async () => {
    const fn = mockFetch(null, { status: 204 });

    await deleteWarehouse('w1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/warehouses/w1');
    expect(init?.method).toBe('DELETE');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });
});
