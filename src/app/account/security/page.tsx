import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import AccountSecurityClient from './AccountSecurityClient';
import { getAuthSession } from '@/lib/auth/access';
import { getProjectAuthConfig } from '@/lib/config/auth';

export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  if (!getProjectAuthConfig().enabled) redirect('/');
  const session = await getAuthSession(await headers());
  if (!session) redirect('/login?next=/account/security');
  const query = await searchParams;
  return <AccountSecurityClient required={query.required === '1'} />;
}
