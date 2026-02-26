import { useCallback, useEffect, useState } from 'react';
import type { User } from '../../domain/auth/types';
import { useServices } from '../../services/useServices';

interface UseAuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

interface UseAuthReturn extends UseAuthState {
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, displayName?: string): Promise<void>;
  signOut(): Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const { auth } = useServices();
  const [state, setState] = useState<UseAuthState>({
    user: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    auth.getCurrentUser().then((user) => {
      if (!cancelled) setState({ user, loading: false, error: null });
    });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const session = await auth.signIn({ email, password });
        setState({ user: session.user, loading: false, error: null });
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Sign-in failed.',
        }));
      }
    },
    [auth]
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName?: string) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const session = await auth.signUp({ email, password, displayName });
        setState({ user: session.user, loading: false, error: null });
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Sign-up failed.',
        }));
      }
    },
    [auth]
  );

  const signOut = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      await auth.signOut();
      setState({ user: null, loading: false, error: null });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Sign-out failed.',
      }));
    }
  }, [auth]);

  return { ...state, signIn, signUp, signOut };
}
