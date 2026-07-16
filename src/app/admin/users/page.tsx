import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import AdminUsersClient from './AdminUsersClient';
import { getAuthSession } from '@/lib/auth/access';
import { isPlatformAdmin } from '@/lib/auth/authorization';
import { getProjectAuthConfig } from '@/lib/config/auth';

export default async function AdminUsersPage() {
  if (!getProjectAuthConfig().enabled) redirect('/');
  const session = await getAuthSession(await headers());
  if (!session) redirect('/login?next=/admin/users');
  if (!isPlatformAdmin(session.user)) notFound();
  return <AdminUsersClient currentUserId={session.user.id} />;
}
