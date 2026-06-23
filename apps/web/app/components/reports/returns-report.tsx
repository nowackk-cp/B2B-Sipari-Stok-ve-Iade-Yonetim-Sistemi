'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReturnsReportView } from '@b2b/contracts';
import { fetchReturnsReport, problemMessages } from '../../../src/lib/reports-client';
import { formatQuantity } from '../../../src/lib/money';
import { StatCard } from '../stat-card';
import { MoneyCard } from '../money-card';
import { monthStartIso, todayIso, type WarehouseOption } from './report-helpers';

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: ReturnsReportView }
  | { status: 'error'; message: string };

/** Return statuses the report contract accepts as a filter. */
const STATUS_FILTERS = ['DRAFT', 'APPROVED', 'RECEIVED', 'REJECTED', 'COMPLETED'] as const;

/**
 * Returns report tab. Aggregated counts, total returned quantity and credit-note
 * totals over the return creation date range (`GET /reports/returns`). Date range,
 * status and warehouse are the only filters the contract exposes. Money is
 * per-currency BigInt-safe; the returned quantity is a BigInt string.
 */
export function ReturnsReport({ warehouses }: { warehouses: WarehouseOption[] }) {
  const [dateFrom, setDateFrom] = useState(monthStartIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [status, setStatus] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    fetchReturnsReport({
      dateFrom,
      dateTo,
      status: status || undefined,
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
  }, [dateFrom, dateTo, status, warehouseId]);

  useEffect(() => load(), [load]);

  return (
    <section aria-label="returns report">
      <div className="toolbar">
        <label className="toolbar-filter">
          <span className="field-label">From</span>
          <input
            type="date"
            aria-label="returns date from"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="toolbar-filter">
          <span className="field-label">To</span>
          <input
            type="date"
            aria-label="returns date to"
            value={dateTo}
            min={dateFrom}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label className="toolbar-filter">
          <span className="field-label">Status</span>
          <select
            aria-label="returns status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {warehouses.length > 0 ? (
          <label className="toolbar-filter">
            <span className="field-label">Warehouse</span>
            <select
              aria-label="returns warehouse"
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
        <div className="table-state" aria-busy="true" data-testid="returns-report-loading">
          Loading returns report…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="returns-report-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.data.returnCount === 0 ? (
        <div className="table-state" data-testid="returns-report-empty">
          No returns in this range.
        </div>
      ) : null}

      {state.status === 'ready' && state.data.returnCount > 0 ? (
        <div className="card-grid" data-testid="returns-report-cards">
          <StatCard label="Returns" value={state.data.returnCount} testId="returns-report-total" />
          <StatCard
            label="Requested"
            value={state.data.requestedCount}
            testId="returns-report-requested"
          />
          <StatCard
            label="Approved"
            value={state.data.approvedCount}
            testId="returns-report-approved"
          />
          <StatCard
            label="Returned quantity"
            value={formatQuantity(state.data.totalReturnedQuantity)}
            testId="returns-report-quantity"
          />
          <StatCard
            label="Credit notes"
            value={state.data.creditNoteCount}
            testId="returns-report-cn-count"
          />
          <MoneyCard
            label="Credit-note total"
            amounts={state.data.creditNoteTotalAmount}
            testId="returns-report-cn-total"
          />
        </div>
      ) : null}
    </section>
  );
}
