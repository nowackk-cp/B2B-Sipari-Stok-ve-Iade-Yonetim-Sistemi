/**
 * Minimal authenticated principal attached to the request by the auth guard.
 * Authentication only — it answers "who is this", never "may they do X". Role
 * names are informational; authorization is a later milestone.
 */
export interface AuthPrincipal {
  /** Internal user PK (for service/data operations). */
  userId: bigint;
  /** Public user UUID (safe to surface). */
  userPublicId: string;
  /** Public session id this access token is bound to. */
  sessionId: string;
  email: string;
  fullName: string;
  roles: string[];
}

/** Property under which the principal is stored on the Express request. */
export const PRINCIPAL_KEY = 'authPrincipal' as const;
