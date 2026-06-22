import { cn } from '@b2b/ui';

/**
 * Status pill for a credit note. Colour is keyed off the lifecycle status so the
 * list and detail stay visually consistent; an unknown status falls back to
 * neutral. In this slice a credit note is created as `ISSUED`.
 */
const TONE: Record<string, string> = {
  ISSUED: 'badge-ok',
  VOID: 'badge-danger',
};

export function CreditNoteStatusBadge({ status }: { status: string }) {
  return <span className={cn('badge', TONE[status] ?? 'badge-muted')}>{status}</span>;
}
