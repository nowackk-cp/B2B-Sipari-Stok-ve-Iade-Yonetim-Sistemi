import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UserProfileView } from '@b2b/contracts';
import { AuthGate } from '../app/components/auth-gate';
import * as authClient from '../src/lib/auth-client';

const replace = vi.fn();
// Next's useRouter returns a stable reference across renders; mirror that so the
// gate's `[router]` effect doesn't re-fire (and re-consume mocks) on every render.
const router = { replace, push: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard',
}));

vi.mock('../src/lib/auth-client', () => ({
  ensureSession: vi.fn(),
  logout: vi.fn(),
}));

const ensureSession = vi.mocked(authClient.ensureSession);
const logout = vi.mocked(authClient.logout);

const USER: UserProfileView = {
  id: 'u-1',
  email: 'ops@b2b.local',
  fullName: 'Ops User',
  status: 'ACTIVE',
  roles: ['ADMIN'],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  replace.mockClear();
  ensureSession.mockReset();
  logout.mockReset();
});

describe('AuthGate', () => {
  it('redirects to /login when there is no session', async () => {
    ensureSession.mockRejectedValueOnce(new Error('no_session'));

    render(
      <AuthGate>
        <div>secret</div>
      </AuthGate>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('renders the protected shell and logs out back to /login', async () => {
    ensureSession.mockResolvedValueOnce(USER);
    logout.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>secret</div>
      </AuthGate>,
    );

    // Shell renders once the session resolves.
    await screen.findByText('secret');
    expect(screen.getByTestId('user-email').textContent).toBe('ops@b2b.local');

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    expect(logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
});
