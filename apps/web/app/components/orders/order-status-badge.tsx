import { cn } from '@b2b/ui';

/**
 * Status pill for an order. Colour is keyed off the lifecycle status so the list
 * and detail stay visually consistent; an unknown status falls back to neutral.
 */
const TONE: Record<string, string> = {
  DRAFT: 'badge-muted',
  APPROVED: 'badge-ok',
  PREPARING: 'badge-ok',
  SHIPPED: 'badge-ok',
  CANCELLED: 'badge-danger',
};

export function OrderStatusBadge({ status }: { status: string }) {
  return <span className={cn('badge', TONE[status] ?? 'badge-muted')}>{status}</span>;
}
