import { describe, expect, it } from 'vitest';
import { cn } from '../src';

describe('cn', () => {
  it('joins truthy class values and drops falsy ones', () => {
    expect(cn('a', false, 'b', undefined, null, 'c')).toBe('a b c');
  });

  it('flattens nested arrays', () => {
    expect(cn('a', ['b', false, ['c']])).toBe('a b c');
  });

  it('returns an empty string when nothing is truthy', () => {
    expect(cn(false, null, undefined)).toBe('');
  });
});
