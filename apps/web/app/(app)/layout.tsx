import type { ReactNode } from 'react';
import { AuthGate } from '../components/auth-gate';

/**
 * Protected layout for the authenticated app. Every page rendered under it is
 * gated by {@link AuthGate} (session probe → redirect to `/login` on failure)
 * and wrapped in the sidebar/topbar shell.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
