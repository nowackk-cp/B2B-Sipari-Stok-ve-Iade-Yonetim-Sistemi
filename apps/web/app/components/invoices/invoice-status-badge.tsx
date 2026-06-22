import { cn } from '@b2b/ui';

/**
 * Status pill for an invoice. Colour is keyed off the lifecycle status so the list
 * and detail stay visually consistent; an unknown status falls back to neutral.
 */
const TONE: Record<string, string> = {
  DRAFT: 'badge-muted',
  ISSUED: 'badge-ok',
  PAID: 'badge-ok',
  VOID: 'badge-danger',
};

export function InvoiceStatusBadge({ status }: { status: string }) {
  return <span className={cn('badge', TONE[status] ?? 'badge-muted')}>{status}</span>;
}
