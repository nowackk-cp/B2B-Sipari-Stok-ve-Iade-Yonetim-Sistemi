import { createApiClient, type ApiClient } from '@b2b/api-client';
import { getWebConfig } from '../env';

/** Central API base URL, validated from the environment. */
export function getApiBaseUrl(): string {
  return getWebConfig().NEXT_PUBLIC_API_BASE_URL;
}

/**
 * Build an API client for server-side use (Server Components / route handlers).
 *
 * The frontend never touches the database directly — all data flows through
 * this client to `/api/v1` (CLAUDE.md Mutlak Kural #1).
 */
export function createServerApiClient(): ApiClient {
  return createApiClient({ baseUrl: getApiBaseUrl(), timeoutMs: 3000 });
}
