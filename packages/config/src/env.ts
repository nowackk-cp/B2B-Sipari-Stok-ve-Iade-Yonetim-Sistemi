import { z } from 'zod';

/**
 * Centralized environment schema for the B2B Operations Suite.
 *
 * Groups are kept independent so each runtime (api / worker / web) only
 * validates the variables it actually needs. Missing or malformed required
 * variables cause a fail-fast {@link EnvValidationError} at boot.
 *
 * No secrets are committed; see `.env.example` for the development template.
 */

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

/** Coerce common boolean-ish strings ("true"/"1"/"yes") to a real boolean. */
const booleanFromString = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
});

const port = z.coerce.number().int().positive().max(65535);

// --- Group: common -----------------------------------------------------------
export const commonEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  APP_NAME: z.string().min(1).default('b2b-operations-suite'),
  LOG_LEVEL: logLevel,
});

// --- Group: postgres ---------------------------------------------------------
export const postgresEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a postgres connection string',
    }),
});

// --- Group: redis ------------------------------------------------------------
export const redisEnvSchema = z.object({
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
      message: 'REDIS_URL must be a redis connection string',
    }),
});

// --- Group: storage (MinIO / S3-compatible) ----------------------------------
export const storageEnvSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromString.default(true),
});

// --- Group: mail -------------------------------------------------------------
export const mailEnvSchema = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: port.default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: booleanFromString.default(false),
  MAIL_FROM: z.string().min(1).default('B2B Operations <no-reply@b2bops.local>'),
});

// --- Group: api --------------------------------------------------------------
export const apiEnvSchema = z.object({
  API_PORT: port.default(3001),
  API_CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  SWAGGER_ENABLED: booleanFromString.default(true),
});

// --- Group: worker -----------------------------------------------------------
export const workerEnvSchema = z.object({
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(1000).default(5),
  WORKER_QUEUE_PREFIX: z.string().min(1).default('b2b'),
  WORKER_INSTANCE_ID: z.string().min(1).optional(),
});

// --- Group: web (browser-exposed values only) --------------------------------
export const webEnvSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.string().url(),
});

// --- Composed per-runtime schemas -------------------------------------------
export const apiConfigSchema = commonEnvSchema
  .merge(postgresEnvSchema)
  .merge(redisEnvSchema)
  .merge(storageEnvSchema)
  .merge(mailEnvSchema)
  .merge(apiEnvSchema);

export const workerConfigSchema = commonEnvSchema
  .merge(postgresEnvSchema)
  .merge(redisEnvSchema)
  .merge(storageEnvSchema)
  .merge(mailEnvSchema)
  .merge(workerEnvSchema);

export const webConfigSchema = commonEnvSchema.merge(webEnvSchema);

export type CommonEnv = z.infer<typeof commonEnvSchema>;
export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type WebConfig = z.infer<typeof webConfigSchema>;

/** Raw environment source (process.env-like). */
export type EnvSource = Record<string, string | undefined>;

/** Thrown when required environment variables are missing or invalid. */
export class EnvValidationError extends Error {
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(context: string, issues: Array<{ path: string; message: string }>) {
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    super(`Invalid environment for "${context}":\n${summary}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Parse and validate an environment object against a schema.
 * Throws {@link EnvValidationError} (fail-fast) when validation fails.
 */
export function parseEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  context: string,
  source: EnvSource = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.length ? issue.path.join('.') : '(root)',
      message: issue.message,
    }));
    throw new EnvValidationError(context, issues);
  }
  return result.data;
}

export function loadApiConfig(source: EnvSource = process.env): ApiConfig {
  return parseEnv(apiConfigSchema, 'api', source);
}

export function loadWorkerConfig(source: EnvSource = process.env): WorkerConfig {
  return parseEnv(workerConfigSchema, 'worker', source);
}

export function loadWebConfig(source: EnvSource = process.env): WebConfig {
  return parseEnv(webConfigSchema, 'web', source);
}
