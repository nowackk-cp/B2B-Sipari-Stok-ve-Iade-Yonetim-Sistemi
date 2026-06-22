import type { ReactNode } from 'react';

/** A single dashboard metric card (label + prominent value). */
export function StatCard({
  label,
  value,
  testId,
  tone,
}: {
  label: string;
  value: ReactNode;
  testId?: string;
  tone?: 'default' | 'warn';
}) {
  return (
    <div className={`card${tone === 'warn' ? ' card-warn' : ''}`}>
      <span className="card-label">{label}</span>
      <span className="card-value" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
