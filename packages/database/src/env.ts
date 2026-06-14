/**
 * Fail-fast DATABASE_URL resolution.
 *
 * The database package never silently falls back to a default connection: a
 * missing or malformed `DATABASE_URL` throws at import/first-use so a
 * misconfigured process cannot start against an unknown database.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('DATABASE_URL is not set. Refusing to start without an explicit database.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL.');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`DATABASE_URL must use the postgresql:// scheme (got "${parsed.protocol}").`);
  }
  return url;
}

/** True when running in production (controls connection logging + lifecycle). */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}
