import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  REDACTION_CENSOR,
  createLogger,
  getRequestContext,
  isSensitiveKey,
  runWithRequestContext,
  setRequestContext,
} from '../src';

/** Collects newline-delimited JSON log lines emitted by pino. */
function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString('utf8').trim();
      for (const line of text.split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      cb();
    },
  });
  const logger = createLogger({
    service: 'test',
    environment: 'test',
    level: 'trace',
    destination: stream,
  });
  return { logger, lines };
}

describe('logger / redaction', () => {
  it('redacts the known sensitive top-level fields', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        authorization: 'Bearer abc',
        cookie: 'sid=123',
        password: 'hunter2',
        passphrase: 'open sesame',
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        idToken: 'id-1',
        authToken: 'auth-1',
        bearerToken: 'b-1',
        apiToken: 'apt-1',
        apiKey: 'key-1',
        clientSecret: 'cs-1',
        secret: 's-1',
        safe: 'visible',
      },
      'sensitive',
    );

    const entry = lines.at(-1)!;
    for (const field of [
      'authorization',
      'cookie',
      'password',
      'passphrase',
      'accessToken',
      'refreshToken',
      'idToken',
      'authToken',
      'bearerToken',
      'apiToken',
      'apiKey',
      'clientSecret',
      'secret',
    ]) {
      expect(entry[field], field).toBe(REDACTION_CENSOR);
    }
    expect(entry.safe).toBe('visible');
  });

  it('redacts a root generic `token` field', () => {
    const { logger, lines } = captureLogger();
    logger.info({ token: 'raw-token', userId: 7 }, 'generic token');
    const entry = lines.at(-1)!;
    expect(entry.token).toBe(REDACTION_CENSOR);
    expect(entry.userId).toBe(7);
  });

  it('redacts a nested `token` at arbitrary depth', () => {
    const { logger, lines } = captureLogger();
    logger.info({ a: { b: { c: { token: 'deep' } } } }, 'nested token');
    const entry = lines.at(-1)! as { a: { b: { c: { token: unknown } } } };
    expect(entry.a.b.c.token).toBe(REDACTION_CENSOR);
  });

  it('redacts tokens inside arrays', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        sessions: [
          { id: 1, token: 't1' },
          { id: 2, accessToken: 't2' },
        ],
      },
      'array token',
    );
    const entry = lines.at(-1)! as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(entry.sessions[0]!.token).toBe(REDACTION_CENSOR);
    expect(entry.sessions[0]!.id).toBe(1);
    expect(entry.sessions[1]!.accessToken).toBe(REDACTION_CENSOR);
  });

  it('redacts snake_case `access_token`', () => {
    const { logger, lines } = captureLogger();
    logger.info({ access_token: 'snake', refresh_token: 'snake2' }, 'snake case');
    const entry = lines.at(-1)!;
    expect(entry.access_token).toBe(REDACTION_CENSOR);
    expect(entry.refresh_token).toBe(REDACTION_CENSOR);
  });

  it('redacts the Authorization header (case-insensitive, nested)', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      { req: { headers: { Authorization: 'Bearer x', 'set-cookie': 'c' } } },
      'http headers',
    );
    const entry = lines.at(-1)! as {
      req: { headers: Record<string, unknown> };
    };
    expect(entry.req.headers.Authorization).toBe(REDACTION_CENSOR);
    expect(entry.req.headers['set-cookie']).toBe(REDACTION_CENSOR);
  });

  it('does NOT redact non-sensitive measurement fields', () => {
    const { logger, lines } = captureLogger();
    logger.info({ tokenCount: 42, tokenUsage: { total: 99 }, tokenizer: 'bpe' }, 'metrics');
    const entry = lines.at(-1)! as {
      tokenCount: unknown;
      tokenUsage: { total: unknown };
      tokenizer: unknown;
    };
    expect(entry.tokenCount).toBe(42);
    expect(entry.tokenUsage.total).toBe(99);
    expect(entry.tokenizer).toBe('bpe');
  });

  it('redacts secrets carried in Error metadata', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('boom') as Error & { metadata?: unknown };
    err.metadata = { secret: 'top-secret', clientSecret: 'cs', requestId: 'r-1' };
    logger.error({ err }, 'failure with metadata');
    const entry = lines.at(-1)! as {
      err: { type: string; message: string; stack: string; metadata: Record<string, unknown> };
    };
    expect(entry.err.type).toBe('Error');
    expect(entry.err.message).toBe('boom');
    expect(typeof entry.err.stack).toBe('string');
    expect(entry.err.metadata.secret).toBe(REDACTION_CENSOR);
    expect(entry.err.metadata.clientSecret).toBe(REDACTION_CENSOR);
    expect(entry.err.metadata.requestId).toBe('r-1');
  });
});

describe('logger / isSensitiveKey', () => {
  it('classifies known and generic secret keys', () => {
    for (const key of [
      'token',
      'access_token',
      'refreshToken',
      'idToken',
      'authToken',
      'bearerToken',
      'apiToken',
      'apiKey',
      'x-api-key',
      'authorization',
      'Cookie',
      'password',
      'passphrase',
      'clientSecret',
      'secret',
      'csrfToken',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('leaves non-secret fields alone', () => {
    for (const key of ['tokenCount', 'tokenUsage', 'tokenizer', 'userId', 'email', 'status']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('logger / request context', () => {
  it('injects requestId/correlationId/userId from AsyncLocalStorage', () => {
    const { logger, lines } = captureLogger();
    runWithRequestContext({ requestId: 'req-1', correlationId: 'corr-1' }, () => {
      setRequestContext({ userId: 'user-9' });
      logger.info('inside');
    });
    const entry = lines.at(-1)!;
    expect(entry.requestId).toBe('req-1');
    expect(entry.correlationId).toBe('corr-1');
    expect(entry.userId).toBe('user-9');
  });

  it('omits context fields when logging outside a request scope', () => {
    const { logger, lines } = captureLogger();
    logger.info('outside');
    const entry = lines.at(-1)!;
    expect(entry.requestId).toBeUndefined();
    expect(getRequestContext()).toBeUndefined();
  });
});
