import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import {
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
} from '../../src/modules/auth/cookies/refresh-cookie';
import { fakeConfig } from './_fakes';

interface CookieCall {
  name: string;
  value: string;
  opts: Record<string, unknown>;
}

function fakeResponse() {
  const calls: { set: CookieCall[]; cleared: CookieCall[] } = { set: [], cleared: [] };
  const res = {
    cookie(name: string, value: string, opts: Record<string, unknown>) {
      calls.set.push({ name, value, opts });
      return res;
    },
    clearCookie(name: string, opts: Record<string, unknown>) {
      calls.cleared.push({ name, value: '', opts });
      return res;
    },
  } as unknown as Response;
  return { res, calls };
}

describe('refresh cookie', () => {
  it('sets HttpOnly, SameSite=Strict, narrow path and explicit max-age', () => {
    const { res, calls } = fakeResponse();
    setRefreshCookie(res, fakeConfig(), 'the-token');
    expect(calls.set).toHaveLength(1);
    const call = calls.set[0]!;
    expect(call.name).toBe('b2b_refresh_token');
    expect(call.value).toBe('the-token');
    expect(call.opts.httpOnly).toBe(true);
    expect(call.opts.sameSite).toBe('strict');
    expect(call.opts.path).toBe('/api/v1/auth');
    expect(call.opts.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('marks the cookie Secure in production', () => {
    const { res, calls } = fakeResponse();
    setRefreshCookie(
      res,
      fakeConfig({
        refreshCookie: {
          name: 'b2b_refresh_token',
          path: '/api/v1/auth',
          secure: true,
          domain: undefined,
          maxAgeSeconds: 1,
        },
      }),
      't',
    );
    expect(calls.set[0]!.opts.secure).toBe(true);
  });

  it('clears the cookie with the SAME attributes (minus max-age)', () => {
    const { res, calls } = fakeResponse();
    clearRefreshCookie(res, fakeConfig());
    expect(calls.cleared).toHaveLength(1);
    const opts = calls.cleared[0]!.opts;
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('strict');
    expect(opts.path).toBe('/api/v1/auth');
    expect(opts.maxAge).toBeUndefined();
  });

  it('reads the token from the cookie, falling back to the body', () => {
    const config = fakeConfig();
    const reqWithCookie = { cookies: { b2b_refresh_token: 'cookie-token' } } as never;
    expect(readRefreshToken(reqWithCookie, config, 'body-token')).toBe('cookie-token');
    const reqNoCookie = { cookies: {} } as never;
    expect(readRefreshToken(reqNoCookie, config, 'body-token')).toBe('body-token');
    expect(readRefreshToken(reqNoCookie, config, undefined)).toBeUndefined();
  });
});
