import { loadWebConfig, type WebConfig } from '@b2b/config';

let cached: WebConfig | undefined;

/**
 * Validate and return the web environment (fail-fast).
 *
 * Lazy + memoized so a missing variable fails at request/render time rather
 * than during static analysis of unrelated routes at build time.
 */
export function getWebConfig(): WebConfig {
  if (!cached) {
    cached = loadWebConfig(process.env);
  }
  return cached;
}
