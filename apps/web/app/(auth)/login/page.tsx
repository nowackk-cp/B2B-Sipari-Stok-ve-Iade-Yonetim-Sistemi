'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { tokens } from '@b2b/ui';
import { login } from '../../../src/lib/auth-client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.replace('/dashboard');
    } catch {
      // Generic message — never reveals whether the account exists.
      setError('Invalid email or password.');
      setSubmitting(false);
    }
  }

  return (
    <div className="center-screen">
      <section className="panel login-panel">
        <div className="login-brand">
          <strong>{tokens.brand}</strong>
          <span className="login-sub">Sign in to the operations console</span>
        </div>
        <form onSubmit={onSubmit} aria-label="login form" className="login-form">
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              name="email"
              aria-label="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              type="password"
              name="password"
              aria-label="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error ? (
            <p role="alert" data-testid="login-error" className="form-error">
              {error}
            </p>
          ) : null}
          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}
