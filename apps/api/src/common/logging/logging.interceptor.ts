import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from '@b2b/logger';
import { type Observable, tap } from 'rxjs';
import { APP_LOGGER } from '../../app.constants';

/** Logs one structured line per HTTP request with method, path, status, duration. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(@Inject(APP_LOGGER) private readonly logger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => this.write(req, res.statusCode, startedAt),
        error: () => this.write(req, res.statusCode || 500, startedAt),
      }),
    );
  }

  private write(req: Request, statusCode: number, startedAt: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    this.logger.info(
      {
        event: 'http.request',
        method: req.method,
        path: req.originalUrl ?? req.url,
        statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      'request completed',
    );
  }
}
