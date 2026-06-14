import type { Request } from 'express';

/** Best-effort client metadata captured for audit/security records. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** Extract client IP + user-agent from an Express request (no secrets). */
export function requestMeta(req: Request): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
  };
}
