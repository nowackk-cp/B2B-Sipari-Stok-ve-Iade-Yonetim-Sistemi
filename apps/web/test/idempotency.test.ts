import { describe, expect, it } from 'vitest';
import { newIdempotencyKey } from '../src/lib/idempotency';

describe('newIdempotencyKey', () => {
  it('returns a non-empty UUID-shaped string', () => {
    const key = newIdempotencyKey();
    expect(typeof key).toBe('string');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('returns a fresh, unique key on each call', () => {
    const keys = new Set(Array.from({ length: 100 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(100);
  });
});
