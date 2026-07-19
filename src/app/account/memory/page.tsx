import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import PersonalMemoryClient from './PersonalMemoryClient';
import { getAuthSession } from '@/lib/auth/access';
import { getProjectAuthConfig } from '@/lib/config/auth';

export default async function PersonalMemoryPage() {
  if (!getProjectAuthConfig().enabled) redirect('/');
  const session = await getAuthSession(await headers());
  if (!session) redirect('/login?next=/account/memory');
  return <PersonalMemoryClient />;
}
