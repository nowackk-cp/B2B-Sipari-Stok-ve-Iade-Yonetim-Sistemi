import type { MoneyView } from '@b2b/contracts';

/**
 * Format an API money value for display.
 *
 * Money crosses the wire as `{ amount, currency }` where `amount` is a
 * minor-unit integer STRING (CLAUDE.md Mutlak Kural #3 — never a JS `number`).
 * We never parse it into a float: the integer/decimal split is done on the
 * string and the integer part is grouped via `BigInt`, so arbitrarily large
 * totals stay exact. The currency's fraction-digit count is resolved from the
 * Intl currency data (falling back to 2 for unknown codes).
 */
export function formatMoney(amount: string, currency: string, locale = 'tr-TR'): string {
  const negative = amount.trim().startsWith('-');
  const digits = amount.trim().replace(/^[+-]/, '').replace(/\D/g, '') || '0';

  let fractionDigits = 2;
  try {
    fractionDigits =
      new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    fractionDigits = 2;
  }

  const padded = digits.padStart(fractionDigits + 1, '0');
  const cut = padded.length - fractionDigits;
  const intPart = padded.slice(0, cut) || '0';
  const fracPart = fractionDigits > 0 ? padded.slice(cut) : '';

  const intFormatted = new Intl.NumberFormat(locale).format(BigInt(intPart));
  const decimalSep =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ??
    ',';

  const number = fracPart ? `${intFormatted}${decimalSep}${fracPart}` : intFormatted;
  return `${negative ? '-' : ''}${number} ${currency}`;
}

/**
 * Render a list of per-currency money totals as a single display string.
 * Empty/undefined lists collapse to a neutral zero so cards never blow up.
 */
export function formatMoneyList(list: MoneyView[] | null | undefined, locale = 'tr-TR'): string {
  if (!list || list.length === 0) return '—';
  return list.map((m) => formatMoney(m.amount, m.currency, locale)).join(' · ');
}

/**
 * Format a BIGINT quantity for display.
 *
 * Quantities cross the wire as integer STRINGS (stock figures can exceed the JS
 * safe-integer range — CLAUDE.md Mutlak Kural #3 precision safety). We never
 * `Number()` the value: the digits are grouped via `BigInt`, so arbitrarily
 * large counts stay exact. `null`/empty collapses to a neutral dash so cells
 * never blow up on absent data.
 */
export function formatQuantity(value: string | null | undefined, locale = 'tr-TR'): string {
  if (value === null || value === undefined || value.trim() === '') return '—';
  const negative = value.trim().startsWith('-');
  const digits = value.trim().replace(/^[+-]/, '').replace(/\D/g, '');
  if (digits === '') return value; // non-numeric — render verbatim rather than lie
  const grouped = new Intl.NumberFormat(locale).format(BigInt(digits));
  return `${negative ? '-' : ''}${grouped}`;
}
