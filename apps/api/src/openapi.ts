import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { API_GLOBAL_PREFIX } from '@b2b/shared';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './bootstrap';

/**
 * Emit the OpenAPI document to `openapi.json` without starting an HTTP server.
 *
 * Used by CI and `pnpm gen:api-client`. Dummy connection strings are injected
 * for any unset env var because building the spec never opens a connection —
 * it only reflects controller/DTO metadata.
 */
const ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/b2b',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'placeholder',
  S3_SECRET_ACCESS_KEY: 'placeholder-secret',
  S3_BUCKET: 'b2b-files',
  SMTP_HOST: 'localhost',
  SWAGGER_ENABLED: 'false',
};

for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    await app.init();
    const document = buildOpenApiDocument(app);
    const outPath = join(process.cwd(), 'openapi.json');
    writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`OpenAPI document written to ${outPath}`);
  } finally {
    await app.close();
  }
}

generate()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('Failed to generate OpenAPI document', err);
    process.exit(1);
  });
