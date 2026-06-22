'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { UserProfileView } from '@b2b/contracts';
import { ensureSession, logout as apiLogout } from '../../src/lib/auth-client';
import { AuthProvider } from '../../src/lib/auth-context';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

type State =
  | { status: 'loading' }
  | { status: 'ready'; user: UserProfileView }
  | { status: 'redirecting' };

/**
 * Client-side guard for the authenticated app shell.
 *
 * On mount it validates the session via `/auth/refresh` + `/auth/me`. While that
 * is in flight a loading state is shown; on failure the user is redirected to
 * `/login` (deny-by-default — UI gating is convenience only, the API authorises
 * every request). On success the profile is published through {@link AuthProvider}
 * and the sidebar/topbar chrome wraps the page.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    ensureSession()
      .then((user) => {
        if (active) setState({ status: 'ready', user });
      })
      .catch(() => {
        if (!active) return;
        setState({ status: 'redirecting' });
        router.replace('/login');
      });
    return () => {
      active = false;
    };
  }, [router]);

  const logout = useCallback(() => {
    void apiLogout().finally(() => router.replace('/login'));
  }, [router]);

  if (state.status !== 'ready') {
    return (
      <div className="center-screen" aria-busy="true" data-testid="shell-loading">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <AuthProvider value={{ user: state.user, logout }}>
      <div className="shell">
        <Topbar />
        <div className="shell-body">
          <Sidebar />
          <main className="shell-main">{children}</main>
        </div>
      </div>
    </AuthProvider>
  );
}
