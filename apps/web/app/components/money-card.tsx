import type { MoneyView } from '@b2b/contracts';
import { formatMoney } from '../../src/lib/money';

/**
 * A money metric card. The API returns per-currency totals (a `MoneyView[]`);
 * each currency is shown on its own line. An empty/undefined list renders a
 * neutral zero so the card never blows up on no-data.
 */
export function MoneyCard({
  label,
  amounts,
  testId,
}: {
  label: string;
  amounts: MoneyView[] | null | undefined;
  testId?: string;
}) {
  const list = amounts ?? [];

  return (
    <div className="card">
      <span className="card-label">{label}</span>
      <span className="card-value card-money" data-testid={testId}>
        {list.length === 0 ? (
          <span className="card-empty">—</span>
        ) : (
          list.map((m) => (
            <span className="money-line" key={m.currency}>
              {formatMoney(m.amount, m.currency)}
            </span>
          ))
        )}
      </span>
    </div>
  );
}
