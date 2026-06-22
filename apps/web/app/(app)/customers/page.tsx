'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CustomerView } from '@b2b/contracts';
import { ApiError } from '../../../src/lib/api-fetch';
import { listCustomers } from '../../../src/lib/customers-client';
import { CustomerFormModal } from '../../components/customers/customer-form-modal';
import { DeleteCustomerDialog } from '../../components/customers/delete-customer-dialog';

type TypeFilter = 'all' | 'COMPANY' | 'INDIVIDUAL';

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; customers: CustomerView[]; hasNextPage: boolean; nextCursor: string | null }
  | { status: 'error'; message: string };

type Modal =
  | { type: 'create' }
  | { type: 'edit'; customer: CustomerView }
  | { type: 'delete'; customer: CustomerView }
  | null;

/** Map the UI type filter to the backend `type` query param. */
function typeParam(filter: TypeFilter): string | undefined {
  return filter === 'all' ? undefined : filter;
}

/** Human label for a customer kind. */
function typeLabel(type: string): string {
  if (type === 'COMPANY') return 'Company';
  if (type === 'INDIVIDUAL') return 'Individual';
  return type;
}

export default function CustomersPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<Array<string | undefined>>([]);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(() => {
    let active = true;
    setState({ status: 'loading' });
    listCustomers({
      search: search.trim() || undefined,
      type: typeParam(filter),
      cursor,
    })
      .then((page) => {
        if (!active) return;
        setState({
          status: 'ready',
          customers: page.data,
          hasNextPage: page.pageInfo.hasNextPage,
          nextCursor: page.pageInfo.nextCursor,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? (err.problem?.detail ?? err.message)
            : 'Could not load customers. Please try again.';
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
  function onFilterChange(value: TypeFilter) {
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
    <section aria-label="customers">
      <div className="page-head">
        <h1 className="page-title">Customers</h1>
        <div className="page-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setModal({ type: 'create' })}
            data-testid="open-create"
          >
            New customer
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="search"
          className="toolbar-search"
          placeholder="Search code, name, email or tax number…"
          aria-label="search customers"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <label className="toolbar-filter">
          <span className="field-label">Type</span>
          <select
            aria-label="filter by type"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value as TypeFilter)}
          >
            <option value="all">All</option>
            <option value="COMPANY">Company</option>
            <option value="INDIVIDUAL">Individual</option>
          </select>
        </label>
      </div>

      {state.status === 'loading' ? (
        <div className="table-state" aria-busy="true" data-testid="customers-loading">
          Loading customers…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="state-error" role="alert" data-testid="customers-error">
          <p>{state.message}</p>
          <button type="button" className="button" onClick={load}>
            Retry
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.customers.length === 0 ? (
        <div className="table-state" data-testid="customers-empty">
          No customers found.
        </div>
      ) : null}

      {state.status === 'ready' && state.customers.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data-table" data-testid="customers-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Tax number</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {state.customers.map((c) => (
                  <tr key={c.id} data-testid={`customer-row-${c.id}`}>
                    <td>
                      <code>{c.code}</code>
                    </td>
                    <td>{c.name}</td>
                    <td>{typeLabel(c.type)}</td>
                    <td>{c.taxNumber ?? '—'}</td>
                    <td>{c.email ?? '—'}</td>
                    <td>{c.phone ?? '—'}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="button button-sm"
                        onClick={() => setModal({ type: 'edit', customer: c })}
                        data-testid={`edit-${c.id}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button-sm button-danger"
                        onClick={() => setModal({ type: 'delete', customer: c })}
                        data-testid={`delete-${c.id}`}
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
        <CustomerFormModal mode="create" onClose={() => setModal(null)} onSaved={load} />
      ) : null}
      {modal?.type === 'edit' ? (
        <CustomerFormModal
          mode="edit"
          customer={modal.customer}
          onClose={() => setModal(null)}
          onSaved={load}
        />
      ) : null}
      {modal?.type === 'delete' ? (
        <DeleteCustomerDialog
          customer={modal.customer}
          onClose={() => setModal(null)}
          onDeleted={load}
        />
      ) : null}
    </section>
  );
}
