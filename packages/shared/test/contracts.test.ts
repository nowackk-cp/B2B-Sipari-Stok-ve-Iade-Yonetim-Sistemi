import { describe, expect, it } from 'vitest';
import { API_GLOBAL_PREFIX, ERROR_CODES, REQUEST_ID_HEADER } from '../src';

describe('shared contracts', () => {
  it('exposes the canonical API prefix and correlation header', () => {
    expect(API_GLOBAL_PREFIX).toBe('api/v1');
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });

  it('defines the stable error code set used by the RFC 7807 filter', () => {
    expect(ERROR_CODES).toContain('VALIDATION_ERROR');
    expect(ERROR_CODES).toContain('NOT_FOUND');
    expect(ERROR_CODES).toContain('INTERNAL');
    // codes must be unique
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});
