import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@b2b/shared';
import { runWithRequestContext } from '@b2b/logger';

/**
 * Establishes the per-request correlation context.
 *
 * Honors an inbound `X-Request-Id` (API_CONVENTIONS §9) or generates one,
 * echoes it on the response, and binds it into the AsyncLocalStorage context so
 * every log line and the error filter share the same `requestId`.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const requestId = candidate && candidate.trim().length > 0 ? candidate.trim() : randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, () => next());
  }
}
