import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthUser } from '@telecord/shared';
import * as auth from '../lib/auth';

export type AuthStatus = 'carregando' | 'anonimo' | 'autenticado';

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** O serviço de autenticação existe neste ambiente. */
  enabled: boolean;
  providers: { password: boolean; google: boolean };
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Recarrega a sessão a partir do cookie. Usado no retorno do Google. */
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Sessão do telecord.
 *
 * Entrar continua sendo opcional: `anonimo` é um estado normal e final, não um
 * erro. Nada aqui bloqueia o app — quem nunca fez login usa a sala como sempre
 * usou, e a falha do serviço de autenticação também cai em `anonimo` em vez de
 * travar a tela.
 *
 * A renovação é agendada um pouco antes do vencimento, e não a cada requisição
 * que falha: com o token vencendo no meio de uma chamada, a pessoa veria um
 * erro que não é dela.
 */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>(
    auth.isAuthConfigured ? 'carregando' : 'anonimo',
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [providers, setProviders] = useState({ password: false, google: false });
  const renewTimer = useRef<number | null>(null);

  const scheduleRenew = useCallback((expiresIn: number) => {
    if (renewTimer.current !== null) {
      window.clearTimeout(renewTimer.current);
    }
    /*
     * Um minuto de folga, e nunca menos de trinta segundos: com TTL curto, uma
     * margem proporcional daria um laço de renovação a cada poucos segundos.
     */
    const delay = Math.max(30, expiresIn - 60) * 1000;
    renewTimer.current = window.setTimeout(() => {
      void auth.refreshSession().then((session) => {
        if (session === null) {
          setUser(null);
          setStatus('anonimo');
          return;
        }
        setUser(session.user);
        scheduleRenew(session.expiresIn);
      });
    }, delay);
  }, []);

  const reload = useCallback(async () => {
    const session = await auth.refreshSession();
    if (session === null) {
      setUser(null);
      setStatus('anonimo');
      return;
    }
    setUser(session.user);
    setStatus('autenticado');
    scheduleRenew(session.expiresIn);
  }, [scheduleRenew]);

  useEffect(() => {
    if (!auth.isAuthConfigured) return undefined;
    void reload();
    void auth.fetchProviders().then(setProviders);
    return () => {
      if (renewTimer.current !== null) {
        window.clearTimeout(renewTimer.current);
      }
    };
  }, [reload]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const session = await auth.login(email, password);
      setUser(session.user);
      setStatus('autenticado');
      scheduleRenew(session.expiresIn);
    },
    [scheduleRenew],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      const session = await auth.register(email, password, displayName);
      setUser(session.user);
      setStatus('autenticado');
      scheduleRenew(session.expiresIn);
    },
    [scheduleRenew],
  );

  const signOut = useCallback(async () => {
    await auth.logout();
    if (renewTimer.current !== null) {
      window.clearTimeout(renewTimer.current);
    }
    setUser(null);
    setStatus('anonimo');
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      enabled: auth.isAuthConfigured,
      providers,
      signIn,
      signUp,
      signOut,
      reload,
    }),
    [status, user, providers, signIn, signUp, signOut, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth precisa estar dentro de <AuthProvider>.');
  }
  return value;
}
