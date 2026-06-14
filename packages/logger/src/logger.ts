import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './context';

export type { Logger } from 'pino';

export const REDACTION_CENSOR = '[REDACTED]';

/**
 * Exact (normalized) sensitive field names. Normalization lower-cases the key
 * and strips every non-alphanumeric character, so `access_token`, `accessToken`
 * and `Access-Token` all collapse to `accesstoken`.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'apitoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passphrase',
  'clientsecret',
  'secret',
]);

/**
 * Suffixes that mark a key as secret-bearing regardless of its prefix, so
 * generic variants (`csrfToken`, `xApiKey`, `userPassword`, `dbSecret`, ...) are
 * redacted without enumerating every name.
 */
const SENSITIVE_SUFFIXES: readonly string[] = [
  'token',
  'secret',
  'password',
  'apikey',
  'passphrase',
];

/**
 * Measurement / metadata fields that merely *mention* "token" but carry no
 * secret. These are explicitly allow-listed so they are never redacted.
 */
const SAFE_KEYS: ReadonlySet<string> = new Set(['tokencount', 'tokenusage', 'tokenizer']);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Decide whether a field name should be redacted. Case-insensitive and
 * separator-insensitive; allow-lists non-secret measurement fields.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SAFE_KEYS.has(normalized)) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Recursively deep-clone a log payload, replacing the value of any sensitive
 * key with the censor. Walks plain objects and arrays at any depth (including
 * serialized `Error` objects and their extra metadata). Cycles are broken with
 * a `[Circular]` marker; `Date`/`RegExp`/`Buffer` are passed through untouched.
 */
export function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }
  if (value !== null && typeof value === 'object') {
    // Errors are handled by the (redacting) error serializer — message/stack are
    // non-enumerable, so walking them here would lose those fields.
    if (value instanceof Error) return value;
    if (value instanceof Date || value instanceof RegExp || Buffer.isBuffer(value)) {
      return value;
    }
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? REDACTION_CENSOR : redactValue(child, seen);
    }
    return result;
  }
  return value;
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
 *
 * Redaction is performed by a recursive sanitizer in `formatters.log`, which
 * runs *after* serializers — so nested objects, arrays and `Error` metadata are
 * all covered, not just a fixed set of top-level paths.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { service, environment, level = 'info', pretty = false, destination, base } = options;

  const loggerOptions: LoggerOptions = {
    level,
    base: { service, environment, ...base },
    serializers: {
      // Serialize the error (message/stack/extra metadata) then redact secrets
      // that may ride along in custom error properties.
      err: (error: unknown) => redactValue(pino.stdSerializers.err(error as Error)),
      error: (error: unknown) => redactValue(pino.stdSerializers.err(error as Error)),
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
      // Runs after serializers: recursively redact secret-bearing fields.
      log(object) {
        return redactValue(object) as Record<string, unknown>;
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
