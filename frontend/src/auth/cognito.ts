import { Amplify } from 'aws-amplify';
import { fetchAuthSession, signIn, signOut, getCurrentUser } from '@aws-amplify/auth';

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

export { signIn, signOut, getCurrentUser };
