import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Seed the deterministic E2E user before the suite. Runs the API package's seed
 * script as a child process (the web package must not import the database — the
 * boundary rule). DATABASE_URL is inherited from the environment.
 */
export default function globalSetup(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set for the web E2E suite (real PostgreSQL required).');
  }
  const script = join(__dirname, '..', '..', 'api', 'scripts', 'seed-e2e-user.mjs');
  const res = spawnSync('node', [script], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    throw new Error('Failed to seed the E2E user');
  }
}
