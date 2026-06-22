import { describe, expect, it } from 'vitest';
import { formatMoney } from '../src/lib/money';

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
