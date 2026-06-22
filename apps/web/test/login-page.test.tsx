import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from '../app/(auth)/login/page';
import * as authClient from '../src/lib/auth-client';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

vi.mock('../src/lib/auth-client', () => ({
  login: vi.fn(),
}));

const login = vi.mocked(authClient.login);

beforeEach(() => {
  replace.mockClear();
  login.mockReset();
});

function fillAndSubmit(email = 'ops@b2b.local', password = 'secret') {
  fireEvent.change(screen.getByLabelText('email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage', () => {
  it('renders the email/password form', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('email')).toBeDefined();
    expect(screen.getByLabelText('password')).toBeDefined();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDefined();
  });

  it('redirects to /dashboard on successful login', async () => {
    login.mockResolvedValueOnce({
      id: 'u-1',
      email: 'ops@b2b.local',
      fullName: 'Ops',
      status: 'ACTIVE',
      roles: [],
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    render(<LoginPage />);

    fillAndSubmit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(login).toHaveBeenCalledWith('ops@b2b.local', 'secret');
  });

  it('shows a generic error and stays on the page when login fails', async () => {
    login.mockRejectedValueOnce(new Error('invalid_credentials'));
    render(<LoginPage />);

    fillAndSubmit('ops@b2b.local', 'wrong');

    const alert = await screen.findByTestId('login-error');
    expect(alert.textContent).toMatch(/invalid email or password/i);
    expect(replace).not.toHaveBeenCalled();
  });
});
