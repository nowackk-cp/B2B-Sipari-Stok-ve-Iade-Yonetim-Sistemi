import { cn } from '@b2b/ui';

/**
 * Status pill for a return. Colour is keyed off the lifecycle status so the list
 * and detail stay visually consistent; an unknown status falls back to neutral.
 * In this slice a return is `DRAFT` (requested) or `APPROVED` (restocked).
 */
const TONE: Record<string, string> = {
  DRAFT: 'badge-muted',
  APPROVED: 'badge-ok',
};

export function ReturnStatusBadge({ status }: { status: string }) {
  return <span className={cn('badge', TONE[status] ?? 'badge-muted')}>{status}</span>;
}
