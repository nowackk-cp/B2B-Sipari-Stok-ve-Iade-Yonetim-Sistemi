'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SalesReportGroupBy, SalesReportView } from '@b2b/contracts';
import { fetchSalesReport, problemMessages } from '../../../src/lib/reports-client';
import { formatMoney } from '../../../src/lib/money';
import { StatCard } from '../stat-card';
import { monthStartIso, todayIso, type WarehouseOption } from './report-helpers';

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: SalesReportView }
  | { status: 'error'; message: string };

const GROUP_BY: ReadonlyArray<SalesReportGroupBy> = ['day', 'month'];

/**
 * Sales report tab. Aggregates ISSUED invoices into period × currency buckets
 * (`GET /reports/sales`). Date range + groupBy + warehouse are the only filters
 * the backend contract exposes, so the UI sends nothing else. Money is rendered
 * BigInt-safe from the minor-unit strings.
 */
export function SalesReport({ warehouses }: { warehouses: WarehouseOption[] }) {
  const [dateFrom, setDateFrom] = useState(monthStartIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [groupBy, setGroupBy] = useState<SalesReportGroupBy>('day');
  const [warehouseId, setWarehouseId] = useState('');
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    fetchSalesReport({
      dateFrom,
      dateTo,
      groupBy,
      warehouseId: warehouseId || undefined,
    })
      .then((data) => {
        if (active) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (active) setState({ status: 'error', message: problemMessages(err)[0]! });
      });
    return () => {
      active = false;
    };
  }, [dateFrom, dateTo, groupBy, warehouseId]);

  useEffect(() => load(), [load]);

  const rows = state.status === 'ready' ? state.data.rows : [];
  const totalInvoices = rows.reduce((sum, r) => sum + r.invoiceCount, 0);

  return (
    <section aria-label="sales report">
      <div className="toolbar">
        <label className="toolbar-filter">
          <span className="field-label">From</span>
          <input
            type="date"
            aria-label="sales date from"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="toolbar-filter">
          <span className="field-label">To</span>
          <input
            type="date"
            aria-label="sales date to"
            value={dateTo}
            min={dateFrom}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label className="toolbar-filter">
          <span className="field-label">Group by</span>
          <select
            aria-label="group by"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as SalesReportGroupBy)}
          >
            {GROUP_BY.map((g) => (
              <option key={g} value={g}>
                {g === 'day' ? 'Day' : 'Month'}
              </option>
            ))}
          </select>
        </label>
        {warehouses.length > 0 ? (
          <label className="toolbar-filter">
            <span className="field-label">Warehouse</span>
            <select
              aria-label="sales warehouse"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
            >
              <option value="">All</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {state.status === 'loading' ? (
        <div className="table-state" aria-busy="true" data-testid="sales-loading">
          Loading sales report…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="sales-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && rows.length === 0 ? (
        <div className="table-state" data-testid="sales-empty">
          No sales in this range.
        </div>
      ) : null}

      {state.status === 'ready' && rows.length > 0 ? (
        <>
          <div className="card-grid">
            <StatCard label="Buckets" value={rows.length} testId="sales-bucket-count" />
            <StatCard label="Issued invoices" value={totalInvoices} testId="sales-invoice-count" />
          </div>
          <div className="table-wrap">
            <table className="data-table" data-testid="sales-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Currency</th>
                  <th className="num">Invoices</th>
                  <th className="num">Net</th>
                  <th className="num">VAT</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.period}-${r.currency}`}
                    data-testid={`sales-row-${r.period}-${r.currency}`}
                  >
                    <td>{r.period}</td>
                    <td>{r.currency}</td>
                    <td className="num">{r.invoiceCount}</td>
                    <td className="num">{formatMoney(r.subtotalAmount, r.currency)}</td>
                    <td className="num">{formatMoney(r.vatAmount, r.currency)}</td>
                    <td className="num">{formatMoney(r.totalAmount, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
