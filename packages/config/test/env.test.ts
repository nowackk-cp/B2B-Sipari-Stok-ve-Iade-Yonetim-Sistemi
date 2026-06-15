import { describe, expect, it } from 'vitest';
import {
  EnvValidationError,
  loadApiConfig,
  loadWebConfig,
  loadWorkerConfig,
  parseEnv,
  postgresEnvSchema,
} from '../src';

const validApiEnv = {
  NODE_ENV: 'test',
  APP_NAME: 'b2b-test',
  LOG_LEVEL: 'debug',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/b2b',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'minio',
  S3_SECRET_ACCESS_KEY: 'minio12345',
  S3_BUCKET: 'b2b-files',
  SMTP_HOST: 'localhost',
  API_PORT: '3001',
  API_CORS_ORIGINS: 'http://localhost:3000, http://localhost:3002',
  SWAGGER_ENABLED: 'true',
  JWT_ACCESS_SECRET: 'test-only-access-secret-at-least-32-characters-long',
  PASSWORD_RESET_DELIVERY_KEY: 'test-only-reset-delivery-key-at-least-32-bytes-long',
} satisfies Record<string, string>;

describe('config / api', () => {
  it('parses a valid environment and applies defaults + coercions', () => {
    const cfg = loadApiConfig(validApiEnv);

    expect(cfg.NODE_ENV).toBe('test');
    expect(cfg.API_PORT).toBe(3001);
    expect(cfg.SWAGGER_ENABLED).toBe(true);
    expect(cfg.S3_FORCE_PATH_STYLE).toBe(true); // defaulted
    expect(cfg.S3_REGION).toBe('us-east-1'); // defaulted
    expect(cfg.API_CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3002']);
    // Auth defaults.
    expect(cfg.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(cfg.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(cfg.ARGON2_MEMORY_KIB).toBe(19456);
    expect(cfg.AUTH_LOCKOUT_THRESHOLD).toBe(5);
    expect(cfg.REFRESH_COOKIE_PATH).toBe('/api/v1/auth');
  });

  it('rejects a JWT signing secret shorter than 32 characters (fail-fast)', () => {
    expect(() => loadApiConfig({ ...validApiEnv, JWT_ACCESS_SECRET: 'too-short' })).toThrowError(
      EnvValidationError,
    );
  });

  it('fails fast when a required variable is missing', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = validApiEnv;

    expect(() => loadApiConfig(withoutDb)).toThrowError(EnvValidationError);
    try {
      loadApiConfig(withoutDb);
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.some((i) => i.path === 'DATABASE_URL')).toBe(true);
    }
  });

  it('rejects a malformed connection string', () => {
    expect(() =>
      loadApiConfig({ ...validApiEnv, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrowError(/DATABASE_URL/);
  });

  it('allows unauthenticated SMTP outside production (Mailpit dev default)', () => {
    const cfg = loadApiConfig({ ...validApiEnv, NODE_ENV: 'development' });
    expect(cfg.SMTP_USER).toBeUndefined();
    expect(cfg.SMTP_PASSWORD).toBeUndefined();
  });

  it('fails fast in production when SMTP credentials are missing (real provider config absent)', () => {
    const prodEnv = { ...validApiEnv, NODE_ENV: 'production' };
    expect(() => loadApiConfig(prodEnv)).toThrowError(EnvValidationError);
    try {
      loadApiConfig(prodEnv);
    } catch (err) {
      const issues = (err as EnvValidationError).issues;
      expect(issues.some((i) => i.path === 'SMTP_USER')).toBe(true);
      expect(issues.some((i) => i.path === 'SMTP_PASSWORD')).toBe(true);
    }
  });

  it('accepts a production environment once SMTP credentials are provided', () => {
    const cfg = loadApiConfig({
      ...validApiEnv,
      NODE_ENV: 'production',
      SMTP_USER: 'relay-user',
      SMTP_PASSWORD: 'relay-secret',
    });
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.SMTP_USER).toBe('relay-user');
    expect(cfg.SMTP_PASSWORD).toBe('relay-secret');
  });
});

describe('config / worker', () => {
  it('parses worker env with defaults', () => {
    const cfg = loadWorkerConfig(validApiEnv);
    expect(cfg.WORKER_CONCURRENCY).toBe(5);
    expect(cfg.WORKER_QUEUE_PREFIX).toBe('b2b');
  });

  it('coerces WORKER_CONCURRENCY and rejects non-numeric values', () => {
    expect(loadWorkerConfig({ ...validApiEnv, WORKER_CONCURRENCY: '12' }).WORKER_CONCURRENCY).toBe(
      12,
    );
    expect(() => loadWorkerConfig({ ...validApiEnv, WORKER_CONCURRENCY: 'abc' })).toThrowError(
      EnvValidationError,
    );
  });
});

describe('config / web', () => {
  it('validates only browser-exposed values', () => {
    const cfg = loadWebConfig({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/api/v1',
    });
    expect(cfg.NEXT_PUBLIC_API_BASE_URL).toBe('https://api.example.com/api/v1');
  });

  it('fails fast when the public API base URL is missing', () => {
    expect(() => loadWebConfig({ NODE_ENV: 'production' })).toThrowError(EnvValidationError);
  });
});

describe('parseEnv', () => {
  it('includes the context name in the error message', () => {
    expect(() => parseEnv(postgresEnvSchema, 'unit', {})).toThrowError(
      /Invalid environment for "unit"/,
    );
  });
});
