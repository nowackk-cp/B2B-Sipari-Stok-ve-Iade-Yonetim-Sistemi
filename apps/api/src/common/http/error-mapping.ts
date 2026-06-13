import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode, ProblemDetails, ProblemFieldError } from '@b2b/shared';

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'BUSINESS_RULE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

const ERROR_TYPE_BASE = 'https://errors.b2bops.local';

function codeForStatus(status: number): ErrorCode {
  return STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL' : 'BUSINESS_RULE');
}

function typeForCode(code: ErrorCode): string {
  return `${ERROR_TYPE_BASE}/${code.toLowerCase().replace(/_/g, '-')}`;
}

/** Shape of a Nest HttpException JSON response body. */
interface NestExceptionBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
}

function extractValidationErrors(messages: string[]): ProblemFieldError[] {
  return messages.map((message) => ({ field: '(request)', message }));
}

export interface MappedProblem {
  status: number;
  body: ProblemDetails;
}

/**
 * Map any thrown value to an RFC 7807 problem document.
 * Never leaks stack traces or internal error messages for 5xx responses.
 */
export function mapExceptionToProblem(
  exception: unknown,
  context: { instance: string; requestId?: string },
): MappedProblem {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = codeForStatus(status);
    const response = exception.getResponse();

    let detail: string | undefined;
    let errors: ProblemFieldError[] | undefined;
    let title = exception.message;

    if (typeof response === 'string') {
      detail = response;
    } else if (response && typeof response === 'object') {
      const body = response as NestExceptionBody;
      if (Array.isArray(body.message)) {
        errors = extractValidationErrors(body.message);
        detail = 'One or more fields are invalid.';
      } else if (typeof body.message === 'string') {
        detail = body.message;
      }
      if (typeof body.error === 'string') title = body.error;
    }

    return {
      status,
      body: pruneUndefined({
        type: typeForCode(code),
        title,
        status,
        code,
        detail,
        instance: context.instance,
        requestId: context.requestId,
        errors,
      }),
    };
  }

  // Unknown/unexpected error → generic 500, no internal details leaked.
  const status = HttpStatus.INTERNAL_SERVER_ERROR;
  return {
    status,
    body: pruneUndefined({
      type: typeForCode('INTERNAL'),
      title: 'Internal Server Error',
      status,
      code: 'INTERNAL',
      detail: 'An unexpected error occurred.',
      instance: context.instance,
      requestId: context.requestId,
    }),
  };
}

function pruneUndefined(body: ProblemDetails): ProblemDetails {
  const entries = Object.entries(body).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as unknown as ProblemDetails;
}
