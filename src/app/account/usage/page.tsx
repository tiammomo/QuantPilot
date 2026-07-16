import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import AccountUsageClient from './AccountUsageClient';
import { getAuthSession } from '@/lib/auth/access';
import { getProjectAuthConfig } from '@/lib/config/auth';

export default async function AccountUsagePage() {
  if (!getProjectAuthConfig().enabled) redirect('/');
  const session = await getAuthSession(await headers());
  if (!session) redirect('/login?next=/account/usage');
  return <AccountUsageClient />;
}
