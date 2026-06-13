import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped logging context propagated via {@link AsyncLocalStorage}.
 * `requestId` correlates HTTP requests, worker jobs, audit and logs end-to-end.
 */
export interface RequestContext {
  requestId: string;
  correlationId?: string;
  /** Authenticated subject id, when available. Never log PII beyond the id. */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given request context bound for its entire async tree. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Return the active request context, or `undefined` outside a request scope. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Merge fields into the active context (e.g. set `userId` after authentication).
 * No-op when called outside a request scope.
 */
export function setRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}
