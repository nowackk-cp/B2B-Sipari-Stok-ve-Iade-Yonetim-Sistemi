'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UserProfileView } from '@b2b/contracts';
import { ensureSession, logout } from '../../src/lib/auth-client';

type State =
  | { status: 'loading' }
  | { status: 'ready'; user: UserProfileView }
  | { status: 'redirecting' };

export default function DashboardPage() {
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

  async function onLogout() {
    await logout();
    router.replace('/login');
  }

  if (state.status !== 'ready') {
    return (
      <section className="panel" aria-busy="true">
        <p>Loading…</p>
      </section>
    );
  }

  return (
    <section className="panel" aria-label="authenticated shell">
      <h2>Dashboard</h2>
      <div className="kv">
        <span className="key">Signed in as</span>
        <span data-testid="user-email">{state.user.email}</span>
      </div>
      <div className="kv">
        <span className="key">Name</span>
        <span>{state.user.fullName}</span>
      </div>
      <button type="button" onClick={onLogout}>
        Log out
      </button>
    </section>
  );
}
