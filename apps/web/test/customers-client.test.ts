import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCustomer,
  deleteCustomer,
  listCustomers,
  updateCustomer,
} from '../src/lib/customers-client';
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

describe('customers-client', () => {
  it('lists via apiFetch with credentials:"include", bearer token and query string', async () => {
    const fn = mockFetch(
      JSON.stringify({ data: [], pageInfo: { nextCursor: null, hasNextPage: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    await listCustomers({ search: 'acme', type: 'COMPANY' });

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/customers?search=acme&type=COMPANY');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('creates with a JSON body and never sends companyId', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'c1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });

    await createCustomer({
      code: 'CUST-001',
      name: 'Acme Ltd.',
      type: 'COMPANY',
      email: 'billing@acme.example',
    });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/customers');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('companyId');
    expect(sent.code).toBe('CUST-001');
  });

  it('updates a customer by id without sending companyId', async () => {
    const fn = mockFetch(JSON.stringify({ id: 'c1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await updateCustomer('c1', { name: 'Renamed' });

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/customers/c1');
    expect(init?.method).toBe('PATCH');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('companyId');
    expect(sent.name).toBe('Renamed');
  });

  it('soft-deletes a customer via DELETE with the bearer token', async () => {
    const fn = mockFetch(null, { status: 204 });

    await deleteCustomer('c1');

    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/v1/customers/c1');
    expect(init?.method).toBe('DELETE');
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });
});
