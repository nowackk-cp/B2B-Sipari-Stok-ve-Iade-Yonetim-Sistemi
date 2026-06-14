/**
 * Password policy — pure, framework-independent rules shared by the API auth
 * services and their unit tests.
 *
 * Design decisions (SECURITY_MODEL §1, TASK-009 §4):
 *  - **Length over composition.** A 12–128 character minimum, no mandatory
 *    character-class rules (NIST 800-63B aligned). Longer passphrases beat
 *    forced symbols.
 *  - **Unicode normalization is explicit.** Passwords are normalized with NFKC
 *    before hashing/verifying so two visually-identical inputs always match.
 *    Normalization is applied consistently at set-time and verify-time.
 *  - **Whitespace is significant.** We never silently trim leading/trailing
 *    whitespace — a password is taken exactly as typed (after NFKC). Trimming
 *    would change the secret behind the user's back.
 *  - **Local denylist only.** A small built-in list of obviously-weak/breached
 *    passwords is rejected. No external breach API is contacted this milestone.
 */

/** Minimum password length (Unicode code points, post-normalization). */
export const PASSWORD_MIN_LENGTH = 12;

/** Maximum password length — a safe upper bound that still bounds hashing cost. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Small local denylist of obviously weak / commonly-breached passwords and
 * trivial variants. Compared case-insensitively against the normalized input.
 * This is a backstop, not a substitute for a full breached-password service.
 */
const DENYLIST: ReadonlySet<string> = new Set(
  [
    'password',
    'password1',
    'password123',
    'passw0rd',
    'qwerty',
    'qwertyuiop',
    'asdfghjkl',
    'iloveyou',
    'admin',
    'administrator',
    'welcome',
    'welcome1',
    'letmein',
    'changeme',
    'changeme123',
    'login',
    'abc123456',
    '123456',
    '1234567',
    '12345678',
    '123456789',
    '1234567890',
    '111111111111',
    '000000000000',
    'qwerty123456',
    'monkey123456',
    'dragon123456',
    'b2boperations',
  ].map((p) => p.toLowerCase()),
);

/**
 * Apply the canonical NFKC normalization. The ONLY transformation applied to a
 * password; in particular it does not trim whitespace.
 */
export function normalizePassword(raw: string): string {
  return raw.normalize('NFKC');
}

/** Count Unicode code points (so astral characters count as one). */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

export interface PasswordPolicyViolation {
  /** Stable machine code for the specific rule that failed. */
  code: 'TOO_SHORT' | 'TOO_LONG' | 'DENYLISTED';
  message: string;
}

export interface PasswordPolicyResult {
  ok: boolean;
  /** The NFKC-normalized password (what callers should hash). */
  normalized: string;
  violations: PasswordPolicyViolation[];
}

/**
 * Validate a raw password against the policy. Returns the normalized form and
 * any violations; never throws. Callers hash {@link PasswordPolicyResult.normalized}.
 */
export function evaluatePassword(raw: string): PasswordPolicyResult {
  const normalized = normalizePassword(raw);
  const length = codePointLength(normalized);
  const violations: PasswordPolicyViolation[] = [];

  if (length < PASSWORD_MIN_LENGTH) {
    violations.push({
      code: 'TOO_SHORT',
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    });
  }
  if (length > PASSWORD_MAX_LENGTH) {
    violations.push({
      code: 'TOO_LONG',
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    });
  }
  if (DENYLIST.has(normalized.toLowerCase())) {
    violations.push({
      code: 'DENYLISTED',
      message: 'Password is too common; choose a less predictable password.',
    });
  }

  return { ok: violations.length === 0, normalized, violations };
}
