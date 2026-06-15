// Deterministic, isolated environment for API integration tests.
// No real services are contacted — these are placeholders so config validation
// passes during app bootstrap.
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_NAME: 'b2b-api-test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/b2b_test',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET: 'b2b-test',
  SMTP_HOST: 'localhost',
  API_PORT: '3001',
  SWAGGER_ENABLED: 'false',
  // Auth: a >=32-char dev-only signing secret so config validation passes.
  JWT_ACCESS_SECRET: 'test-only-access-secret-at-least-32-characters-long',
  // >=32-byte dev-only AES key for the reset-token delivery cipher.
  PASSWORD_RESET_DELIVERY_KEY: 'test-only-reset-delivery-key-at-least-32-bytes-long',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (!process.env[key]) process.env[key] = value;
}
