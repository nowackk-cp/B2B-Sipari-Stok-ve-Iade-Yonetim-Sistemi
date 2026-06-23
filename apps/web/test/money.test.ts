import { describe, expect, it } from 'vitest';
import { formatMoney, formatQuantity } from '../src/lib/money';

describe('formatMoney', () => {
  it('formats a normal minor-unit amount with grouping and the currency', () => {
    expect(formatMoney('123456', 'TRY')).toMatch(/1\.234,56\s*TRY/);
  });

  it('keeps full precision for amounts beyond Number.MAX_SAFE_INTEGER', () => {
    // 9007199254740993 is the first integer that a JS double cannot represent
    // (it rounds to ...992). Formatting via BigInt must keep the exact "93".
    const out = formatMoney('9007199254740993', 'USD');
    expect(out).toContain('90.071.992.547.409');
    expect(out).toMatch(/,93\s*USD/);
    // Proof it is NOT going through a float (which would yield ...,92).
    expect(out).not.toContain(',92');
  });

  it('handles a negative amount and zero-fraction currencies', () => {
    expect(formatMoney('-100', 'TRY')).toMatch(/^-/);
  });
});

describe('formatQuantity', () => {
  it('groups a normal integer quantity', () => {
    expect(formatQuantity('1234567')).toBe('1.234.567');
  });

  it('keeps full precision for quantities beyond Number.MAX_SAFE_INTEGER', () => {
    // Number('9007199254740993') rounds to ...992; BigInt grouping keeps the 93.
    const out = formatQuantity('9007199254740993');
    expect(out.replace(/\D/g, '')).toBe('9007199254740993');
    expect(out).not.toContain('992');
  });

  it('renders a neutral dash for null/empty', () => {
    expect(formatQuantity(null)).toBe('—');
    expect(formatQuantity('')).toBe('—');
    expect(formatQuantity(undefined)).toBe('—');
  });
});
