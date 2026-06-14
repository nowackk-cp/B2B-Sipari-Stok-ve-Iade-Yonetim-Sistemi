import type { Request, Response } from 'express';
import type { AppConfigService } from '../../../common/config/app-config.service';

/**
 * Refresh-token cookie transport for browser clients (SECURITY_MODEL §1).
 *
 * - HttpOnly: not readable by JS (XSS cannot exfiltrate it).
 * - Secure: true in production (configurable for local http dev).
 * - SameSite=Strict: the cookie is never sent on cross-site requests, which
 *   removes the CSRF surface for the refresh endpoint without a separate CSRF
 *   token. (The access token is a Bearer value held in memory, not a cookie, so
 *   it is not CSRF-exposed either.)
 * - Narrow Path: scoped to the auth routes only.
 * - Explicit Max-Age matching the refresh-token TTL.
 *
 * Logout clears the cookie with the SAME attributes so browsers actually drop it.
 */
function baseOptions(config: AppConfigService): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  domain?: string;
} {
  const c = config.refreshCookie;
  return {
    httpOnly: true,
    secure: c.secure,
    sameSite: 'strict',
    path: c.path,
    ...(c.domain ? { domain: c.domain } : {}),
  };
}

export function setRefreshCookie(res: Response, config: AppConfigService, token: string): void {
  res.cookie(config.refreshCookie.name, token, {
    ...baseOptions(config),
    maxAge: config.refreshCookie.maxAgeSeconds * 1000,
  });
}

export function clearRefreshCookie(res: Response, config: AppConfigService): void {
  res.clearCookie(config.refreshCookie.name, baseOptions(config));
}

/** Read the refresh token from the cookie or, for pure API clients, the body. */
export function readRefreshToken(
  req: Request,
  config: AppConfigService,
  bodyToken?: string,
): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const fromCookie = cookies?.[config.refreshCookie.name];
  return fromCookie ?? (bodyToken && bodyToken.length > 0 ? bodyToken : undefined);
}
