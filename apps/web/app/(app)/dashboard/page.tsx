'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DashboardSummaryView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { fetchDashboardSummary } from '../../../src/lib/dashboard-client';
import { StatCard } from '../../components/stat-card';
import { MoneyCard } from '../../components/money-card';

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: DashboardSummaryView }
  | { status: 'error'; message: string };

/** Numeric metric cards, in display order. */
const METRICS: ReadonlyArray<{
  key: keyof DashboardSummaryView;
  label: string;
  warn?: boolean;
}> = [
  { key: 'totalProducts', label: 'Total products' },
  { key: 'activeProducts', label: 'Active products' },
  { key: 'totalCustomers', label: 'Total customers' },
  { key: 'lowStockProducts', label: 'Low-stock products', warn: true },
  { key: 'draftOrders', label: 'Draft orders' },
  { key: 'approvedOrders', label: 'Approved orders' },
  { key: 'shippedOrders', label: 'Shipped orders' },
  { key: 'issuedInvoices', label: 'Issued invoices' },
  { key: 'requestedReturns', label: 'Requested returns' },
  { key: 'approvedReturns', label: 'Approved returns' },
];

export default function DashboardPage() {
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    fetchDashboardSummary()
      .then((data) => {
        if (active) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load the dashboard. Please try again.';
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <section aria-label="dashboard">
      <h1 className="page-title">Dashboard</h1>

      {state.status === 'loading' ? (
        <div className="card-grid" aria-busy="true" data-testid="dashboard-loading">
          {Array.from({ length: 12 }).map((_, i) => (
            <div className="card card-skeleton" key={i} aria-hidden="true" />
          ))}
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="dashboard-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <div className="card-grid">
          {METRICS.map((m) => (
            <StatCard
              key={m.key}
              label={m.label}
              tone={m.warn ? 'warn' : 'default'}
              testId={`stat-${m.key}`}
              value={(state.data[m.key] as number | undefined) ?? 0}
            />
          ))}
          <MoneyCard
            label="Today's sales"
            amounts={state.data.todaySalesAmount}
            testId="stat-todaySalesAmount"
          />
          <MoneyCard
            label="This month's sales"
            amounts={state.data.monthSalesAmount}
            testId="stat-monthSalesAmount"
          />
        </div>
      ) : null}
    </section>
  );
}
