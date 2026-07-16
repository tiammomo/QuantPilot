import { auth, type ProjectAuthSession } from '@/lib/auth/server';

export async function getAuthSession(headers: Headers): Promise<ProjectAuthSession | null> {
  return auth.api.getSession({
    headers,
    query: { disableRefresh: true },
  });
}

export async function isAuthenticated(headers: Headers): Promise<boolean> {
  return Boolean(await getAuthSession(headers));
}
