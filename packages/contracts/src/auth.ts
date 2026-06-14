/**
 * Public authentication view-models (read DTOs).
 *
 * These are the ONLY shapes the API returns for auth resources. They are
 * deliberately hand-written contracts — never derived from Prisma models — so
 * internal fields (password hash, token digests, sequential bigint ids,
 * `deletedAt`, lock counters) can never leak (API_CONVENTIONS §7a, §7b).
 * Public identity is the UUID `publicId`; the sequential PK is never exposed.
 */

/** Safe, whitelisted projection of a user for `/auth/me` and login responses. */
export interface UserProfileView {
  /** Public UUID identity (never the sequential PK). */
  id: string;
  email: string;
  fullName: string;
  /** Account status (ACTIVE / SUSPENDED / INVITED). */
  status: string;
  /**
   * Role names the user holds. Informational only — authorization decisions are
   * made server-side from permissions, never from this list (SECURITY_MODEL §2).
   */
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

/** Bearer access-token envelope returned by login / refresh. */
export interface AuthTokenView {
  tokenType: 'Bearer';
  /** Short-lived signed JWT. */
  accessToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

/** Login / refresh response: token envelope + the authenticated profile. */
export interface AuthSessionView extends AuthTokenView {
  user: UserProfileView;
}

/** A single refresh session, as listed by `GET /auth/sessions`. */
export interface SessionView {
  /** Public session id (UUID) used to revoke a specific session. */
  id: string;
  /** True for the session that issued the current request's refresh token. */
  current: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  /** Best-effort client metadata captured at issue/last-use time. */
  ip: string | null;
  userAgent: string | null;
}

/** Generic acknowledgement body for endpoints with no resource payload. */
export interface MessageView {
  message: string;
}
