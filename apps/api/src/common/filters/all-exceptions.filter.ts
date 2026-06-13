import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from '@b2b/logger';
import { getRequestContext } from '@b2b/logger';
import { APP_LOGGER } from '../../app.constants';
import { mapExceptionToProblem } from '../http/error-mapping';

const PROBLEM_JSON = 'application/problem+json';

/**
 * Global exception filter: converts every thrown value into an RFC 7807
 * problem+json response, attaches the correlation `requestId`, and logs at the
 * appropriate level. Stack traces are logged but never returned to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = getRequestContext()?.requestId;

    const { status, body } = mapExceptionToProblem(exception, {
      instance: req.originalUrl ?? req.url,
      requestId,
    });

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, path: body.instance, statusCode: status },
        'unhandled exception',
      );
    } else if (!(exception instanceof HttpException) || status >= HttpStatus.BAD_REQUEST) {
      this.logger.warn(
        { path: body.instance, statusCode: status, code: body.code },
        'request error',
      );
    }

    res.status(status).type(PROBLEM_JSON).json(body);
  }
}
