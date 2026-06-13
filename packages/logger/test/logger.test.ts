import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  REDACTION_CENSOR,
  createLogger,
  getRequestContext,
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
  it('redacts sensitive top-level fields', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        authorization: 'Bearer abc',
        cookie: 'sid=123',
        password: 'hunter2',
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        apiKey: 'key-1',
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
      'accessToken',
      'refreshToken',
      'apiKey',
      'secret',
    ]) {
      expect(entry[field], field).toBe(REDACTION_CENSOR);
    }
    expect(entry.safe).toBe('visible');
  });

  it('redacts sensitive fields nested under headers/body', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      { headers: { authorization: 'Bearer x', cookie: 'c' }, body: { password: 'p' } },
      'nested',
    );
    const entry = lines.at(-1)! as {
      headers: Record<string, unknown>;
      body: Record<string, unknown>;
    };
    expect(entry.headers.authorization).toBe(REDACTION_CENSOR);
    expect(entry.headers.cookie).toBe(REDACTION_CENSOR);
    expect(entry.body.password).toBe(REDACTION_CENSOR);
  });

  it('serializes errors with stack instead of leaking raw objects', () => {
    const { logger, lines } = captureLogger();
    logger.error({ err: new Error('boom') }, 'failure');
    const entry = lines.at(-1)! as { err: { type: string; message: string; stack: string } };
    expect(entry.err.type).toBe('Error');
    expect(entry.err.message).toBe('boom');
    expect(typeof entry.err.stack).toBe('string');
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
