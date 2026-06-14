import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  evaluatePassword,
  normalizePassword,
} from '../src';

describe('password policy', () => {
  it('accepts a sufficiently long passphrase', () => {
    const res = evaluatePassword('correct horse battery staple');
    expect(res.ok).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it('rejects passwords shorter than the minimum', () => {
    const res = evaluatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('TOO_SHORT');
  });

  it('accepts exactly the minimum length', () => {
    expect(evaluatePassword('x'.repeat(PASSWORD_MIN_LENGTH)).ok).toBe(true);
  });

  it('rejects passwords longer than the maximum', () => {
    const res = evaluatePassword('x'.repeat(PASSWORD_MAX_LENGTH + 1));
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('TOO_LONG');
  });

  it('rejects common denylisted passwords (case-insensitive)', () => {
    expect(evaluatePassword('Password123').ok).toBe(false);
    expect(evaluatePassword('password123').violations.map((v) => v.code)).toContain('DENYLISTED');
  });

  it('applies NFKC normalization and returns the normalized form', () => {
    // Fullwidth characters normalize to ASCII under NFKC.
    const raw = 'ｐａｓｓwordvalue123';
    const res = evaluatePassword(raw);
    expect(res.normalized).toBe(normalizePassword(raw));
    expect(res.normalized).toBe('passwordvalue123');
  });

  it('does NOT trim significant leading/trailing whitespace', () => {
    const raw = '  spaced out password  ';
    expect(normalizePassword(raw)).toBe(raw);
    expect(evaluatePassword(raw).normalized).toBe(raw);
  });

  it('counts astral code points as single characters', () => {
    // 11 emoji = 11 code points, below the 12 minimum.
    expect(evaluatePassword('😀'.repeat(11)).ok).toBe(false);
    expect(evaluatePassword('😀'.repeat(12)).ok).toBe(true);
  });
});
