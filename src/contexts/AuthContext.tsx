'use client';

import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';

import { authClient } from '@/lib/auth/client';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role?: string;
  banned?: boolean | null;
  mustChangePassword?: boolean;
}

interface AuthContextType {
  enabled: boolean;
  user: AuthUser | null;
  isPending: boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function EnabledAuthProvider({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const pathname = usePathname();

  useEffect(() => {
    if (session.isPending || session.data || pathname === '/login') return;
    const next = `${window.location.pathname}${window.location.search}`;
    const login = new URL('/login', window.location.origin);
    if (next !== '/') login.searchParams.set('next', next);
    window.location.assign(login.toString());
  }, [pathname, session.data, session.isPending]);

  const value = useMemo<AuthContextType>(() => ({
    enabled: true,
    user: (session.data?.user as AuthUser | undefined) ?? null,
    isPending: session.isPending,
    signOut: async () => {
      await authClient.signOut();
      window.location.assign('/login');
    },
    refresh: session.refetch,
  }), [session.data?.user, session.isPending, session.refetch]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  if (enabled) return <EnabledAuthProvider>{children}</EnabledAuthProvider>;
  return (
    <AuthContext.Provider value={{
      enabled: false,
      user: null,
      isPending: false,
      signOut: async () => undefined,
      refresh: async () => undefined,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}
