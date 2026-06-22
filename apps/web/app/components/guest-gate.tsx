'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ensureSession } from '../../src/lib/auth-client';

/**
 * Inverse of {@link AuthGate} for public (guest) routes such as `/login`.
 *
 * If a valid session already exists, an authenticated user landing on `/login`
 * is bounced to `/dashboard`; otherwise the public children render. The probe is
 * best-effort and never blocks the form for unauthenticated visitors.
 */
export function GuestGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    ensureSession()
      .then(() => {
        if (active) router.replace('/dashboard');
      })
      .catch(() => {
        if (active) setChecked(true);
      });
    return () => {
      active = false;
    };
  }, [router]);

  if (!checked) {
    return (
      <div className="center-screen" aria-busy="true" data-testid="guest-loading">
        <p>Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
}
