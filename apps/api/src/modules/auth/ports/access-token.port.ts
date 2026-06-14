/**
 * Minimal access-token claim set (SECURITY_MODEL §1). Deliberately small: the
 * subject + session, standard registered claims, and nothing else. No roles,
 * permissions, warehouse scope, email or other PII are embedded — authorization
 * is resolved server-side per request.
 */
export interface AccessTokenClaims {
  /** Subject — the user's public UUID (never the sequential PK). */
  sub: string;
  /** Session id — the refresh session's public UUID. */
  sid: string;
  /** Unique token id (replay/debugging correlation). */
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface IssueAccessTokenInput {
  /** User public id. */
  subject: string;
  /** Session public id. */
  sessionId: string;
}

export interface IssuedAccessToken {
  token: string;
  /** Lifetime in seconds. */
  expiresIn: number;
  claims: AccessTokenClaims;
}

/** Thrown when an access token is malformed, mis-signed, or expired. */
export class InvalidAccessTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidAccessTokenError';
  }
}

/**
 * Access-token signer port. The current binding is symmetric HS256; the
 * interface is signature-method agnostic so swapping to RS256 asymmetric keys
 * later is a provider change only (SECURITY_MODEL §1).
 */
export interface AccessTokenSigner {
  issue(input: IssueAccessTokenInput): IssuedAccessToken;
  /** Verify signature + standard claims, returning the decoded claims or throwing. */
  verify(token: string): AccessTokenClaims;
}
