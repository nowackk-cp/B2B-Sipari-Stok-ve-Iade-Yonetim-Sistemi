import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../src/lib/api-fetch';

function mockFetch(body: unknown, init: ResponseInit) {
  const fn = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init,
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('always sends cookies with credentials: "include"', async () => {
    const fn = mockFetch({ ok: true }, { status: 200 });

    await apiFetch('/dashboard/summary', { accessToken: 'tok' });

    expect(fn).toHaveBeenCalledTimes(1);
    const [, init] = fn.mock.calls[0]!;
    expect(init).toMatchObject({ credentials: 'include' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('serialises a JSON body and sets content-type', async () => {
    const fn = mockFetch({ ok: true }, { status: 200 });

    await apiFetch('/auth/login', { method: 'POST', json: { email: 'a@b.c', password: 'x' } });

    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/auth/login');
    expect(init?.body).toBe(JSON.stringify({ email: 'a@b.c', password: 'x' }));
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('parses an RFC 7807 problem+json body into an ApiError', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'FORBIDDEN',
      detail: 'Missing permission dashboard:read',
    };
    mockFetch(problem, { status: 403 });

    const err = await apiFetch('/dashboard/summary').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(403);
    expect(apiErr.code).toBe('FORBIDDEN');
    expect(apiErr.problem?.detail).toBe('Missing permission dashboard:read');
    expect(apiErr.message).toBe('Forbidden');
  });

  it('returns undefined for a 204 No Content response', async () => {
    mockFetch(undefined, { status: 204 });
    await expect(apiFetch('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});
