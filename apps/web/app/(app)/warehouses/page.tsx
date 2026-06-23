'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WarehouseView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { listWarehouses } from '../../../src/lib/warehouses-client';
import { WarehouseFormModal } from '../../components/warehouses/warehouse-form-modal';
import { DeleteWarehouseDialog } from '../../components/warehouses/delete-warehouse-dialog';

type ActiveFilter = 'all' | 'active' | 'inactive';

type ListState =
  | { status: 'loading' }
  | {
      status: 'ready';
      warehouses: WarehouseView[];
      hasNextPage: boolean;
      nextCursor: string | null;
    }
  | { status: 'error'; message: string };

type Modal =
  | { type: 'create' }
  | { type: 'edit'; warehouse: WarehouseView }
  | { type: 'delete'; warehouse: WarehouseView }
  | null;

/** Map the tri-state UI filter to the backend `isActive` query param. */
function activeParam(filter: ActiveFilter): string | undefined {
  if (filter === 'active') return 'true';
  if (filter === 'inactive') return 'false';
  return undefined;
}

export default function WarehousesPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActiveFilter>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<Array<string | undefined>>([]);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    listWarehouses({
      search: search.trim() || undefined,
      isActive: activeParam(filter),
      cursor,
    })
      .then((page) => {
        if (!active) return;
        setState({
          status: 'ready',
          warehouses: page.data,
          hasNextPage: page.pageInfo.hasNextPage,
          nextCursor: page.pageInfo.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load warehouses. Please try again.';
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, [search, filter, cursor]);

  useEffect(() => load(), [load]);

  /** Reset to the first page whenever a filter changes (the cursor is positional). */
  function onSearchChange(value: string) {
    setPrevCursors([]);
    setCursor(undefined);
    setSearch(value);
  }
  function onFilterChange(value: ActiveFilter) {
    setPrevCursors([]);
    setCursor(undefined);
    setFilter(value);
  }

  function goNext() {
    if (state.status !== 'ready' || !state.hasNextPage || !state.nextCursor) return;
    setPrevCursors((prev) => [...prev, cursor]);
    setCursor(state.nextCursor);
  }
  function goPrev() {
    if (prevCursors.length === 0) return;
    const previous = prevCursors[prevCursors.length - 1];
    setPrevCursors((prev) => prev.slice(0, -1));
    setCursor(previous);
  }

  const canPrev = prevCursors.length > 0;

  return (
    <section aria-label="warehouses">
      <div className="page-head">
        <h1 className="page-title">Warehouses</h1>
        <div className="page-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setModal({ type: 'create' })}
            data-testid="open-create"
          >
            New warehouse
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="search"
          className="toolbar-search"
          placeholder="Search code or name…"
          aria-label="search warehouses"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <label className="toolbar-filter">
          <span className="field-label">Status</span>
          <select
            aria-label="filter by status"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value as ActiveFilter)}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {state.status === 'loading' ? (
        <div className="table-state" aria-busy="true" data-testid="warehouses-loading">
          Loading warehouses…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="warehouses-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.warehouses.length === 0 ? (
        <div className="table-state" data-testid="warehouses-empty">
          No warehouses found.
        </div>
      ) : null}

      {state.status === 'ready' && state.warehouses.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data-table" data-testid="warehouses-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>City</th>
                  <th>Country</th>
                  <th>Status</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {state.warehouses.map((w) => (
                  <tr key={w.id} data-testid={`warehouse-row-${w.id}`}>
                    <td>
                      <code>{w.code}</code>
                    </td>
                    <td>{w.name}</td>
                    <td>{w.city ?? '—'}</td>
                    <td>{w.country ?? '—'}</td>
                    <td>
                      <span className={`badge ${w.isActive ? 'badge-ok' : 'badge-muted'}`}>
                        {w.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="button button-sm"
                        onClick={() => setModal({ type: 'edit', warehouse: w })}
                        data-testid={`edit-${w.id}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button-sm button-danger"
                        onClick={() => setModal({ type: 'delete', warehouse: w })}
                        data-testid={`delete-${w.id}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <button
              type="button"
              className="button button-sm"
              onClick={goPrev}
              disabled={!canPrev}
              data-testid="page-prev"
            >
              Previous
            </button>
            <button
              type="button"
              className="button button-sm"
              onClick={goNext}
              disabled={!state.hasNextPage}
              data-testid="page-next"
            >
              Next
            </button>
          </div>
        </>
      ) : null}

      {modal?.type === 'create' ? (
        <WarehouseFormModal mode="create" onClose={() => setModal(null)} onSaved={load} />
      ) : null}
      {modal?.type === 'edit' ? (
        <WarehouseFormModal
          mode="edit"
          warehouse={modal.warehouse}
          onClose={() => setModal(null)}
          onSaved={load}
        />
      ) : null}
      {modal?.type === 'delete' ? (
        <DeleteWarehouseDialog
          warehouse={modal.warehouse}
          onClose={() => setModal(null)}
          onDeleted={load}
        />
      ) : null}
    </section>
  );
}
