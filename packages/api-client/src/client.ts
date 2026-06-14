import type { HealthStatus, ProblemDetails } from '@b2b/contracts';
import { buildUrl } from './url';

export interface ApiClientOptions {
  /** API base URL, e.g. `http://localhost:3001/api/v1`. */
  baseUrl: string;
  /** Optional fetch implementation (injectable for tests / SSR). */
  fetch?: typeof fetch;
  /** Default per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Error thrown for non-2xx responses, carrying the RFC 7807 body when present. */
export class ApiError extends Error {
  public readonly status: number;
  public readonly problem?: ProblemDetails;

  constructor(status: number, message: string, problem?: ProblemDetails) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

/**
 * Minimal hand-written API client used by the web foundation shell.
 *
 * In TASK-015 the request/response types are replaced by an OpenAPI-generated
 * schema (`src/generated/schema.ts`); the surface here stays stable.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('No fetch implementation available; pass one via options.fetch.');
    }
  }

  /** Liveness probe — `GET /health/live`. */
  getLiveness(signal?: AbortSignal): Promise<HealthStatus> {
    return this.get<HealthStatus>('/health/live', signal);
  }

  /** Readiness probe (dependencies) — `GET /health/ready`. */
  getReadiness(signal?: AbortSignal): Promise<HealthStatus> {
    return this.get<HealthStatus>('/health/ready', signal);
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const url = buildUrl(this.baseUrl, path);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const body: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        const problem = body as ProblemDetails | undefined;
        throw new ApiError(res.status, problem?.title ?? `Request failed: ${res.status}`, problem);
      }
      return body as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}
