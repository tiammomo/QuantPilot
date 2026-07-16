import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import LoginClient from './LoginClient';
import { getDevelopmentAdminDefaults, getProjectAuthConfig } from '@/lib/config/auth';

export const metadata: Metadata = {
  title: '登录 · QuantPilot',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const config = getProjectAuthConfig();
  if (!config.enabled) redirect('/');
  const query = await searchParams;
  const nextPath = typeof query.next === 'string' ? query.next : undefined;
  const developmentDefaults = getDevelopmentAdminDefaults(config);
  return (
    <LoginClient
      nextPath={nextPath}
      rememberMe={config.session.rememberMe}
      developmentAdmin={developmentDefaults ? {
        login: developmentDefaults.login,
        email: developmentDefaults.email,
      } : null}
    />
  );
}
