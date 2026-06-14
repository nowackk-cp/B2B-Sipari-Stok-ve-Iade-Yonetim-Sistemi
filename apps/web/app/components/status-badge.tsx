import type { HealthState } from '@b2b/contracts';
import { cn } from '@b2b/ui';

const LABELS: Record<HealthState | 'pending', string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  error: 'Down',
  pending: 'In development',
};

export function StatusBadge({ state }: { state: HealthState | 'pending' }) {
  return (
    <span className={cn('badge', state)}>
      <span className="dot" aria-hidden />
      {LABELS[state]}
    </span>
  );
}
