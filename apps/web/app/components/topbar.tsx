'use client';

import { tokens } from '@b2b/ui';
import { useAuth } from '../../src/lib/auth-context';

/** Top bar: brand, signed-in identity and a logout action. */
export function Topbar() {
  const { user, logout } = useAuth();

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <strong>{tokens.brand}</strong>
        <span className="topbar-sub">Operations Console</span>
      </div>
      <div className="topbar-user">
        <span className="topbar-email" data-testid="user-email">
          {user.email}
        </span>
        <button type="button" className="button" onClick={logout}>
          Log out
        </button>
      </div>
    </header>
  );
}
