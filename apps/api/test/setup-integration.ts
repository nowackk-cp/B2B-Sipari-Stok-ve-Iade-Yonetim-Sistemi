// Environment for booted-app integration tests against REAL PostgreSQL.
//
// DATABASE_URL is provided by the fail-closed gate runner (or CI service) and is
// NOT defaulted here — a real, reachable test database is mandatory. Every other
// variable gets a deterministic test value so config validation passes. argon2
// cost is lowered (still argon2id) so the many hash operations stay fast.
const REQUIRED_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  APP_NAME: 'b2b-api-integration',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET: 'b2b-test',
  SMTP_HOST: 'localhost',
  API_PORT: '3001',
  SWAGGER_ENABLED: 'false',
  JWT_ACCESS_SECRET: 'test-only-access-secret-at-least-32-characters-long',
  JWT_ACCESS_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_DAYS: '30',
  ARGON2_MEMORY_KIB: '8192',
  ARGON2_ITERATIONS: '2',
  ARGON2_PARALLELISM: '1',
  PASSWORD_RESET_TTL_MINUTES: '30',
  AUTH_LOCKOUT_THRESHOLD: '5',
  AUTH_LOCKOUT_DURATION_MINUTES: '15',
  LOGIN_RATE_LIMIT_MAX: '10',
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: '300',
};

for (const [key, value] of Object.entries(REQUIRED_DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set for API integration tests (real PostgreSQL required).');
}
