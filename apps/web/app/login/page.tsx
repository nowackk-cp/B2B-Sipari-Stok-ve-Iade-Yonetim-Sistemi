'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { login } from '../../src/lib/auth-client';

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
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h2>Sign in</h2>
      <form onSubmit={onSubmit} aria-label="login form">
        <label className="kv" style={{ display: 'block', marginBottom: 12 }}>
          <span className="key">Email</span>
          <input
            type="email"
            name="email"
            aria-label="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: '100%' }}
          />
        </label>
        <label className="kv" style={{ display: 'block', marginBottom: 12 }}>
          <span className="key">Password</span>
          <input
            type="password"
            name="password"
            aria-label="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: '100%' }}
          />
        </label>
        {error ? (
          <p role="alert" data-testid="login-error" style={{ color: 'crimson' }}>
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
