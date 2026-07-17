'use client';

import { Gauge, KeyRound } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import { PageHeader } from '@/components/layout/PageHeader';
import { SubNav, subNavPanelId, subNavTabId, type SubNavItem } from '@/components/layout/SubNav';
import { cn } from '@/lib/utils';

const ACCOUNT_NAV_ITEMS: SubNavItem[] = [
  { id: 'usage', label: '用量与配额', icon: <Gauge className="h-4 w-4" /> },
  { id: 'security', label: '账号与会话', icon: <KeyRound className="h-4 w-4" /> },
];

const ACCOUNT_PATHS: Record<string, string> = {
  usage: '/account/usage',
  security: '/account/security',
};

interface AccountPageShellProps {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}

export function AccountPageShell({
  title,
  subtitle,
  actions,
  children,
  contentClassName,
}: AccountPageShellProps) {
  const pathname = usePathname() ?? '/account/usage';
  const router = useRouter();
  const activeId = pathname.startsWith('/account/security') ? 'security' : 'usage';

  return (
    <div className="platform-shell min-h-dvh">
      <PageHeader
        compactOnMobile
        title={title}
        subtitle={subtitle}
        badge={(
          <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-1 text-[10px] font-semibold text-primary">
            账号中心
          </span>
        )}
      >
        {actions}
      </PageHeader>
      <SubNav
        compactOnMobile
        ariaLabel="账号中心导航"
        items={ACCOUNT_NAV_ITEMS}
        activeId={activeId}
        onChange={(id) => {
          const href = ACCOUNT_PATHS[id];
          if (href && href !== pathname) router.push(href);
        }}
      />
      <main
        id={subNavPanelId(activeId)}
        role="tabpanel"
        aria-labelledby={subNavTabId(activeId)}
        tabIndex={0}
        className={cn(
          'platform-content mx-auto w-full px-4 py-6 sm:px-6 sm:py-8',
          contentClassName,
        )}
      >
        {children}
      </main>
    </div>
  );
}

export type { AccountPageShellProps };
