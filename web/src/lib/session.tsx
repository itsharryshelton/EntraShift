/**
 * Session context. Loads GET /api/me once at boot and exposes the current
 * engineer identity + auth state to the app. The session itself is a
 * server-side HttpOnly cookie — this holds only the non-sensitive identity
 * (upn/displayName/groupOk) plus the CSRF token used by api.ts.
 *
 * There is no client-side token storage. If /api/me returns 401 (or any request
 * dispatches the `entrashift:unauthorized` event), we flip to unauthenticated
 * and the router sends the engineer to the sign-in redirect screen.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { getMe, type Me } from './api';

type AuthState =
  | { status: 'loading' }
  | { status: 'authenticated'; me: Me }
  | { status: 'unauthenticated' };

interface SessionContextValue {
  state: AuthState;
  reload: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const reload = useCallback(async () => {
    try {
      const me = await getMe();
      setState({ status: 'authenticated', me });
    } catch {
      setState({ status: 'unauthenticated' });
    }
  }, []);

  useEffect(() => {
    void reload();
    const onUnauth = () => setState({ status: 'unauthenticated' });
    window.addEventListener('entrashift:unauthorized', onUnauth);
    return () => window.removeEventListener('entrashift:unauthorized', onUnauth);
  }, [reload]);

  return (
    <SessionContext.Provider value={{ state, reload }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
