/**
 * Audit-specific defensive redaction. The audit row must NEVER contain a
 * password, password hash, raw token, token digest, cookie or authorization
 * header (TASK-009 §8). Callers already pass safe domain projections; this is a
 * backstop that masks any key whose name marks it as a secret.
 *
 * Matching is suffix/exact based (not substring) so descriptive metadata like
 * `passwordChangedAt` or `otherSessionsRevoked` is preserved while `password`,
 * `passwordHash`, `tokenDigest`, `refreshToken`, etc. are masked. It is broader
 * than the logger's redaction in that, for an audit context, `hash` and `digest`
 * suffixes are also treated as secret.
 */
export const AUDIT_CENSOR = '[REDACTED]';

const EXACT = new Set(['cookie', 'setcookie', 'authorization']);
const SUFFIXES = ['password', 'passphrase', 'secret', 'token', 'apikey', 'hash', 'digest'];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key: string): boolean {
  const n = normalizeKey(key);
  if (EXACT.has(n)) return true;
  return SUFFIXES.some((s) => n.endsWith(s));
}

export function redactForAudit(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v, seen));
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? AUDIT_CENSOR : redactForAudit(child, seen);
    }
    return out;
  }
  return value;
}
