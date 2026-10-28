import { Amplify } from 'aws-amplify';
import { fetchAuthSession, signIn, signOut, getCurrentUser } from '@aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from '@aws-amplify/auth/cognito';

/** sessionStorage-backed key-value store for Amplify: tokens live for the tab, not for 30 days on disk. */
const sessionStore = {
  async setItem(key: string, value: string) { sessionStorage.setItem(key, value); },
  async getItem(key: string) { return sessionStorage.getItem(key); },
  async removeItem(key: string) { sessionStorage.removeItem(key); },
  async clear() { sessionStorage.clear(); },
};

/** Configure Amplify Auth from build-time env (populated from CDK outputs). */
export function configureAuth(): void {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
      },
    },
  });
  // Amplify's default stores id/access/REFRESH tokens in localStorage, where any script on the origin
  // (or a browser extension) can read them and they survive for the refresh token's lifetime. Session
  // storage scopes them to the tab and clears on close (feature-47, audit #7).
  cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStore);
  // Tokens the previous build left in localStorage would otherwise stay readable (and the refresh token valid
  // for its original 30 days) on every browser that visited before this change.
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('CognitoIdentityServiceProvider.')) localStorage.removeItem(k);
  } catch { /* storage disabled — nothing to purge */ }
}

/** Returns the current JWT for Authorization headers, or null if not signed in. */
export async function getIdToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

/** The signed-in user's email (from the id token), for display in the sidebar. */
export async function getUserEmail(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload as Record<string, unknown> | undefined;
    return (payload?.email as string) ?? null;
  } catch {
    return null;
  }
}

/** Whether the signed-in user belongs to the Cognito `admin` group (id-token `cognito:groups`). */
export async function isAdminUser(): Promise<boolean> {
  try {
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload as Record<string, unknown> | undefined;
    const groups = payload?.['cognito:groups'];
    const list = Array.isArray(groups) ? groups.map(String) : typeof groups === 'string' ? groups.split(',') : [];
    return list.map((g) => g.trim()).includes('admin');
  } catch { return false; }
}

export { signIn, signOut, getCurrentUser };
