import { expect, test } from '@playwright/test';
import { buildUrl, createApiClient } from '@b2b/api-client';

/**
 * Contract smoke: the api-client (which the web app and future browser specs
 * depend on) targets the canonical health routes under the configured base URL.
 * This needs no browser and no running server.
 */
test.describe('api-client contract', () => {
  test('builds canonical health URLs under /api/v1', () => {
    const base = 'http://localhost:3001/api/v1';
    expect(buildUrl(base, '/health/live')).toBe('http://localhost:3001/api/v1/health/live');
    expect(buildUrl(base, '/health/ready')).toBe('http://localhost:3001/api/v1/health/ready');
  });

  test('client surfaces typed readiness via an injected fetch', async () => {
    const client = createApiClient({
      baseUrl: 'http://api.test/api/v1',
      fetch: async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            service: 'api',
            version: '0.0.0',
            timestamp: new Date().toISOString(),
            environment: 'test',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    const health = await client.getReadiness();
    expect(health.status).toBe('ok');
    expect(health.service).toBe('api');
  });
});
