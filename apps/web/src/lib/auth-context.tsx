'use client';

import { createContext, useContext } from 'react';
import type { UserProfileView } from '@b2b/contracts';

export interface AuthState {
  /** The authenticated profile (informational; authz is server-side). */
  user: UserProfileView;
  /** Log out (calls the API, then bounces to `/login`). */
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider = AuthContext.Provider;

/** Read the authenticated session from inside the protected app shell. */
export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within the authenticated app shell.');
  }
  return value;
}
