import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CreditNoteListView, CreditNoteView } from '@b2b/contracts';
import CreditNotesPage from '../app/(app)/credit-notes/page';
import { ApiError } from '../src/lib/api-fetch';
import * as creditNotesClient from '../src/lib/credit-notes-client';

vi.mock('../src/lib/credit-notes-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/credit-notes-client')>();
  return { ...actual, listCreditNotes: vi.fn(), getCreditNote: vi.fn() };
});

const listCreditNotes = vi.mocked(creditNotesClient.listCreditNotes);
const getCreditNote = vi.mocked(creditNotesClient.getCreditNote);

const money = (amount: string, currency = 'TRY') => ({ amount, currency });

function creditNote(over: Partial<CreditNoteView> = {}): CreditNoteView {
  return {
    id: 'cn-1',
    creditNoteNo: 'CRN-2026-000001',
    creditNoteNumber: '1',
    seriesCode: 'CRN',
    fiscalYear: 2026,
    status: 'ISSUED',
    returnId: 'ret-1',
    orderId: 'ord-1',
    originalInvoiceId: 'inv-1',
    customerId: 'cust-1',
    warehouseId: 'wh-1',
    currency: 'TRY',
    subtotal: money('10000'),
    vat: money('2000'),
    total: money('12000'),
    items: [
      {
        productId: 'p1',
        description: 'Widget',
        quantity: '2',
        unitPrice: money('5000'),
        vatRate: 2000,
        lineSubtotal: money('10000'),
        lineVat: money('2000'),
        lineTotal: money('12000'),
      },
    ],
    issuedAt: '2026-01-04T00:00:00.000Z',
    createdAt: '2026-01-04T00:00:00.000Z',
    ...over,
  };
}

function creditNotePage(
  creditNotes: CreditNoteView[],
  hasNextPage = false,
  nextCursor: string | null = null,
): CreditNoteListView {
  return { data: creditNotes, pageInfo: { hasNextPage, nextCursor } };
}

beforeEach(() => {
  vi.clearAllMocks();
  listCreditNotes.mockResolvedValue(creditNotePage([creditNote()]));
  getCreditNote.mockResolvedValue(creditNote());
});

describe('CreditNotesPage — list', () => {
  it('shows loading then renders the credit note rows', async () => {
    render(<CreditNotesPage />);
    expect(screen.getByTestId('credit-notes-loading')).toBeDefined();
    await screen.findByTestId('credit-notes-table');
    expect(screen.getByText('CRN-2026-000001')).toBeDefined();
  });

  it('renders an empty state when there are no credit notes', async () => {
    listCreditNotes.mockResolvedValue(creditNotePage([]));
    render(<CreditNotesPage />);
    await screen.findByTestId('credit-notes-empty');
  });

  it('shows an error state with a working retry', async () => {
    listCreditNotes.mockRejectedValueOnce(new Error('boom'));
    render(<CreditNotesPage />);
    await screen.findByTestId('credit-notes-error');
    listCreditNotes.mockResolvedValueOnce(creditNotePage([creditNote()]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('credit-notes-table');
  });

  it('reflects the status filter in the list query', async () => {
    render(<CreditNotesPage />);
    await screen.findByTestId('credit-notes-table');
    fireEvent.change(screen.getByLabelText('filter by status'), { target: { value: 'VOID' } });
    await waitFor(() =>
      expect(listCreditNotes).toHaveBeenCalledWith(expect.objectContaining({ status: 'VOID' })),
    );
  });

  it('paginates with Next/Previous using the cursor', async () => {
    listCreditNotes.mockResolvedValueOnce(creditNotePage([creditNote()], true, 'cur-2'));
    render(<CreditNotesPage />);
    await screen.findByTestId('credit-notes-table');

    listCreditNotes.mockResolvedValueOnce(
      creditNotePage([creditNote({ id: 'cn-2', creditNoteNo: 'CRN-2026-000002' })]),
    );
    fireEvent.click(screen.getByTestId('page-next'));

    await waitFor(() =>
      expect(listCreditNotes).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'cur-2' }),
      ),
    );
    await screen.findByText('CRN-2026-000002');
  });

  it('formats large totals without precision loss', async () => {
    // 90,071,992,547,409.91 — beyond Number.MAX_SAFE_INTEGER in minor units.
    listCreditNotes.mockResolvedValue(
      creditNotePage([creditNote({ total: money('9007199254740991') })]),
    );
    render(<CreditNotesPage />);
    await screen.findByTestId('credit-notes-table');

    const cell = screen.getByTestId('credit-note-total-cn-1');
    expect(cell.textContent).toContain('90.071.992.547.409,91');
  });
});

describe('CreditNotesPage — detail', () => {
  it('opens the drawer and lists the credit note line items', async () => {
    render(<CreditNotesPage />);
    await screen.findByTestId('credit-notes-table');

    fireEvent.click(screen.getByTestId('open-detail-cn-1'));

    await screen.findByTestId('credit-note-detail-drawer');
    expect(getCreditNote).toHaveBeenCalledWith('cn-1');
    const items = await screen.findByTestId('credit-note-items-table');
    expect(within(items).getByText('Widget')).toBeDefined();
    expect(screen.getByTestId('detail-credit-note-no').textContent).toBe('CRN-2026-000001');
  });

  it('shows an RFC7807 error in the detail drawer with a working retry', async () => {
    getCreditNote.mockRejectedValueOnce(
      new ApiError(404, 'Not Found', {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: 'Credit note not found',
      }),
    );
    render(<CreditNotesPage />);
    await screen.findByTestId('credit-notes-table');

    fireEvent.click(screen.getByTestId('open-detail-cn-1'));
    const error = await screen.findByTestId('credit-note-detail-error');
    expect(error.textContent).toMatch(/credit note not found/i);

    getCreditNote.mockResolvedValueOnce(creditNote());
    fireEvent.click(within(error).getByRole('button', { name: /retry/i }));
    await screen.findByTestId('credit-note-items-table');
  });

  it('does not render a PDF/download button', async () => {
    render(<CreditNotesPage />);
    await screen.findByTestId('credit-notes-table');
    fireEvent.click(screen.getByTestId('open-detail-cn-1'));
    await screen.findByTestId('credit-note-detail-drawer');
    expect(screen.queryByRole('button', { name: /pdf|download/i })).toBeNull();
  });
});
