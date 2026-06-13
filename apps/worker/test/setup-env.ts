// Isolated worker env for unit tests. Redis is never dialed in these tests.
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_NAME: 'b2b-worker-test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/b2b_test',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET: 'b2b-test',
  SMTP_HOST: 'localhost',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (!process.env[key]) process.env[key] = value;
}
