import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './context';

export type { Logger } from 'pino';

/**
 * Sensitive field names that must never appear in plaintext logs.
 * Covers auth headers, cookies, credentials and token/secret material.
 */
export const REDACTED_FIELDS = [
  'authorization',
  'cookie',
  'password',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
] as const;

export const REDACTION_CENSOR = '[REDACTED]';

/**
 * Build the list of redaction paths. pino redaction is path-based, so we cover
 * the bare keys plus the common containers (headers, body, req, request,
 * context, data) at one and two levels of nesting.
 */
function buildRedactPaths(): string[] {
  const containers = [
    '',
    '*.',
    'req.',
    'request.',
    'res.',
    'response.',
    'headers.',
    'req.headers.',
    'body.',
    'req.body.',
    'context.',
    'data.',
  ];
  const paths = new Set<string>();
  for (const field of REDACTED_FIELDS) {
    for (const container of containers) {
      paths.add(`${container}${field}`);
    }
  }
  return [...paths];
}

export interface CreateLoggerOptions {
  /** Logical service name, e.g. "api" or "worker". */
  service: string;
  /** Deployment environment (development/test/production). */
  environment: string;
  /** Minimum level to emit. Defaults to "info". */
  level?: LoggerOptions['level'];
  /** Pretty-print for local development (requires optional `pino-pretty`). */
  pretty?: boolean;
  /** Optional destination stream (used by tests to capture output). */
  destination?: DestinationStream;
  /** Extra static bindings merged into every log line. */
  base?: Record<string, unknown>;
}

/**
 * Create a structured JSON logger with secret redaction and automatic
 * request-context enrichment (`requestId`, `correlationId`, `userId`).
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { service, environment, level = 'info', pretty = false, destination, base } = options;

  const loggerOptions: LoggerOptions = {
    level,
    base: { service, environment, ...base },
    redact: {
      paths: buildRedactPaths(),
      censor: REDACTION_CENSOR,
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    // Inject the active request context into every line.
    mixin() {
      const ctx = getRequestContext();
      if (!ctx) return {};
      const fields: Record<string, unknown> = { requestId: ctx.requestId };
      if (ctx.correlationId) fields.correlationId = ctx.correlationId;
      if (ctx.userId) fields.userId = ctx.userId;
      return fields;
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (pretty && !destination) {
    loggerOptions.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    };
    return pino(loggerOptions);
  }

  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}
