import { describe, expect, it, vi } from 'vitest';
import { ApiError, buildUrl, createApiClient } from '../src';
import type { HealthStatus } from '../src';

describe('buildUrl', () => {
  it('collapses duplicate slashes at the base/path boundary', () => {
    expect(buildUrl('http://localhost:3001/api/v1/', '/health/live')).toBe(
      'http://localhost:3001/api/v1/health/live',
    );
    expect(buildUrl('http://localhost:3001/api/v1', 'health/ready')).toBe(
      'http://localhost:3001/api/v1/health/ready',
    );
  });
});

describe('ApiClient', () => {
  const health: HealthStatus = {
    status: 'ok',
    service: 'api',
    version: '0.0.0',
    timestamp: '2026-06-13T00:00:00.000Z',
    environment: 'test',
  };

  it('returns the parsed health body on success', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(health), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1', fetch: fetchMock });

    await expect(client.getLiveness()).resolves.toEqual(health);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/health/live',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('throws an ApiError carrying the problem+json body on failure', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      code: 'INTERNAL',
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(problem), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1', fetch: fetchMock });

    await expect(client.getReadiness()).rejects.toBeInstanceOf(ApiError);
  });
});
