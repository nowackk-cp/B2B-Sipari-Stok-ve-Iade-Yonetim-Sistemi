'use client';

import { type FormEvent, useState } from 'react';
import type { ProductImportResultView } from '@b2b/contracts';
import { importProducts, problemMessages } from '../../../src/lib/products-client';
import { Modal } from '../modal';

type State =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; result: ProductImportResultView }
  | { status: 'error'; messages: string[] };

/**
 * CSV import dialog. Uploads the chosen file (multipart), shows a simple
 * uploading state, then either a success summary (imported count, status, id)
 * or the per-row validation errors / duplicate-file (409) message returned as
 * RFC 7807. A successful import asks the page to refresh the list.
 */
export function ImportProductsModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>({ status: 'idle' });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setState({ status: 'error', messages: ['Choose a CSV file to import.'] });
      return;
    }
    setState({ status: 'uploading' });
    try {
      const result = await importProducts(file);
      setState({ status: 'done', result });
      onImported();
    } catch (err) {
      setState({ status: 'error', messages: problemMessages(err) });
    }
  }

  return (
    <Modal title="Import products (CSV)" onClose={onClose} testId="product-import-modal">
      {state.status === 'done' ? (
        <div data-testid="import-summary">
          <p className="import-ok">Import {state.result.status.toLowerCase()}.</p>
          <dl className="import-summary">
            <div>
              <dt>Imported</dt>
              <dd data-testid="import-applied">{state.result.appliedRows}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd data-testid="import-status">{state.result.status}</dd>
            </div>
            <div>
              <dt>Import id</dt>
              <dd data-testid="import-id">
                <code>{state.result.id}</code>
              </dd>
            </div>
          </dl>
          <div className="modal-actions">
            <button type="button" className="button button-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} aria-label="import form">
          <label className="field field-wide">
            <span className="field-label">CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="csv file"
              data-testid="import-file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <p className="field-hint">
            Columns: sku, name, currency, listPriceAmount, taxRateBp (description,
            criticalStockThreshold, isActive optional).
          </p>

          {state.status === 'error' ? (
            <ul className="form-error-list" role="alert" data-testid="import-error">
              {state.messages.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          ) : null}

          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={state.status === 'uploading'}
            >
              {state.status === 'uploading' ? 'Uploading…' : 'Import'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
