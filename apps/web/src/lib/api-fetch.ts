import type { ProblemDetails } from '@b2b/contracts';

/**
 * Central browser API client for the web app.
 *
 * Every business call goes through `/api/v1` (CLAUDE.md Mutlak Kural #1) and
 * always sends the HttpOnly cookies (`credentials: 'include'`) so the refresh
 * session travels with the request. Non-2xx responses are surfaced as
 * {@link ApiError} carrying the parsed RFC 7807 problem+json body
 * (docs/ERROR_HANDLING.md) — callers branch on `error.status` / `error.code`.
 */

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

  /** Stable, machine-readable error code (RFC 7807 `code`) when the API set one. */
  get code(): string | undefined {
    return this.problem?.code;
  }
}

/** Validated API base URL (e.g. `http://localhost:3001/api/v1`). */
export function apiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_API_BASE_URL is not configured');
  return url;
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** Access token to send as a Bearer credential (kept in memory, never stored). */
  accessToken?: string | null;
  /** JSON-serialisable request body; the helper stringifies and sets content-type. */
  json?: unknown;
  /**
   * Raw request body (e.g. a `FormData` multipart upload). When set, no
   * `content-type` is added so the browser can attach the multipart boundary
   * itself. Mutually exclusive with {@link ApiFetchOptions.json}.
   */
  body?: BodyInit | null;
}

/** Issue the request with the shared config (cookies + bearer + content-type). */
async function apiRequest(path: string, opts: ApiFetchOptions): Promise<Response> {
  const { accessToken, json, body, headers, ...rest } = opts;
  const hasJson = json !== undefined;

  return fetch(`${apiBaseUrl()}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(hasJson ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: hasJson ? JSON.stringify(json) : (body ?? undefined),
  });
}

/** Read the RFC 7807 body of a non-2xx response and throw it as an {@link ApiError}. */
async function throwProblem(res: Response): Promise<never> {
  const problem = (await res.json().catch(() => undefined)) as ProblemDetails | undefined;
  throw new ApiError(res.status, problem?.title ?? `Request failed: ${res.status}`, problem);
}

/**
 * Fetch from the API and return the raw {@link Response} (for non-JSON payloads
 * such as a CSV export blob, where the caller needs `res.blob()` and headers).
 *
 * Same wire config as {@link apiFetch} — always sends cookies, attaches the
 * bearer token, and throws {@link ApiError} (parsed problem+json) on non-2xx.
 */
export async function apiFetchResponse(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<Response> {
  const res = await apiRequest(path, opts);
  if (!res.ok) await throwProblem(res);
  return res;
}

/**
 * Fetch JSON from the API.
 *
 * - Always sends cookies (`credentials: 'include'`).
 * - Attaches the in-memory access token as a Bearer header when provided.
 * - Parses the RFC 7807 body and throws {@link ApiError} on non-2xx.
 * - Returns `undefined` for 204 No Content.
 */
export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const res = await apiRequest(path, opts);

  if (res.status === 204) return undefined as T;

  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const problem = body as ProblemDetails | undefined;
    throw new ApiError(res.status, problem?.title ?? `Request failed: ${res.status}`, problem);
  }
  return body as T;
}
