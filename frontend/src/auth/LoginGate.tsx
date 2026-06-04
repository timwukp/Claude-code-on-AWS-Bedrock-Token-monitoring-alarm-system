import { useEffect, useState, ReactNode } from 'react';
import { signIn, signOut, getCurrentUser } from './cognito';

/**
 * Minimal auth gate: renders children only when a Cognito session exists, otherwise shows a
 * sign-in form. Uses SRP (the secure default) via Amplify. Good enough for the demo; swap for
 * the Cognito Hosted UI / a fuller flow in production.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentUser().then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await signIn({ username: email, password });
      setAuthed(true);
    } catch (err: any) {
      setError(err?.message ?? 'Sign-in failed');
    }
  }

  if (authed === null) return <p style={{ padding: 24 }}>Loading…</p>;

  if (!authed) {
    return (
      <div style={{ maxWidth: 320, margin: '80px auto', fontFamily: 'system-ui' }}>
        <h2>Token Usage Monitoring</h2>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit">Sign in</button>
          {error && <p style={{ color: 'crimson' }}>{error}</p>}
        </form>
      </div>
    );
  }

  return (
    <div>
      <div style={{ textAlign: 'right', padding: 8 }}>
        <button onClick={() => signOut().then(() => setAuthed(false))}>Sign out</button>
      </div>
      {children}
    </div>
  );
}
