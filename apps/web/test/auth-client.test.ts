import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionView } from '@b2b/contracts';
import { getAccessToken, login, logout, setAccessToken } from '../src/lib/auth-client';

const SESSION: AuthSessionView = {
  tokenType: 'Bearer',
  accessToken: 'access-123',
  expiresIn: 900,
  user: {
    id: 'u-1',
    email: 'ops@b2b.local',
    fullName: 'Ops User',
    status: 'ACTIVE',
    roles: ['ADMIN'],
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

function stubFetch(impl: typeof fetch) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('auth-client', () => {
  it('login stores the access token in memory and returns the profile', async () => {
    const fn = stubFetch(
      async () => new Response(JSON.stringify(SESSION), { status: 200 }),
    );

    const user = await login('ops@b2b.local', 'pw');

    expect(user.email).toBe('ops@b2b.local');
    expect(getAccessToken()).toBe('access-123');
    const [, init] = fn.mock.calls[0]!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
  });

  it('logout clears the in-memory token even if the API call fails', async () => {
    setAccessToken('access-123');
    stubFetch(async () => {
      throw new Error('network down');
    });

    await logout().catch(() => undefined);

    expect(getAccessToken()).toBeNull();
  });
});
