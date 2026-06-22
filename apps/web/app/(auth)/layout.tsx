import type { ReactNode } from 'react';
import { GuestGate } from '../components/guest-gate';

/**
 * Public (guest) layout for unauthenticated routes such as `/login`.
 * Centres its child and redirects already-authenticated users to the dashboard.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <GuestGate>{children}</GuestGate>;
}
