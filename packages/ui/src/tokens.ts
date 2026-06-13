/**
 * Minimal design tokens shared across surfaces. Expanded into a full
 * shadcn/ui theme in Phase 7 (web module screens).
 */
export const tokens = {
  brand: 'B2B Operations Suite',
  radius: '0.5rem',
  status: {
    ok: '#16a34a',
    degraded: '#d97706',
    error: '#dc2626',
    pending: '#64748b',
  },
} as const;

export type StatusTone = keyof typeof tokens.status;
