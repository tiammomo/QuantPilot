'use client';

import { BrainCircuit, Gauge, KeyRound, LogOut, ShieldCheck, UserRound, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

type AuthUserMenuVariant = 'floating' | 'header';

const SHARED_PAGE_HEADER_PREFIXES = [
  '/strategy-platform',
  '/research-reports',
  '/business-knowledge',
  '/ops-platform',
] as const;

function routeUsesIntegratedAccountNavigation(pathname: string): boolean {
  return pathname === '/'
    || pathname === '/account'
    || pathname.startsWith('/account/')
    || /^\/[^/]+\/chat\/?$/.test(pathname)
    || /^\/eval-platform\/runs\/[^/]+\/?$/.test(pathname)
    || SHARED_PAGE_HEADER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function AuthUserMenu({ variant = 'floating' }: { variant?: AuthUserMenuVariant }) {
  const { enabled, user, isPending, signOut } = useAuth();
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (
    !enabled
    || isPending
    || !user
    || (variant === 'floating' && routeUsesIntegratedAccountNavigation(pathname))
  ) return null;

  const displayName = user.name || user.email;
  const initial = displayName.slice(0, 1).toUpperCase();
  const accountLinks = [
    { href: '/account/usage', label: '用量与配额', icon: Gauge },
    { href: '/account/memory', label: '用户记忆', icon: BrainCircuit },
    { href: '/account/security', label: '账号与会话', icon: KeyRound },
    ...(user.role === 'admin'
      ? [{ href: '/admin/users', label: '用户管理', icon: Users }]
      : []),
  ];

  return (
    <div className={variant === 'floating' ? 'fixed bottom-4 right-4 z-40' : 'shrink-0'}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              'border-border/70 bg-background/90 shadow-sm backdrop-blur-xl',
              variant === 'floating'
                ? 'h-11 rounded-full px-3 shadow-lg'
                : 'h-9 w-9 rounded-xl px-0 sm:w-auto sm:px-2',
            )}
            aria-label={`打开账号菜单，当前用户 ${displayName}`}
          >
            <span className={cn(
              'flex shrink-0 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground',
              variant === 'floating' ? 'h-7 w-7 text-xs' : 'h-6 w-6 text-[10px]',
            )}>
              {initial || <UserRound className="h-4 w-4" />}
            </span>
            <span className={cn('max-w-28 truncate', variant === 'header' && 'hidden 2xl:inline')}>
              {displayName}
            </span>
          </Button>
        </SheetTrigger>

        <SheetContent side="right" className="flex w-[min(92vw,380px)] flex-col gap-0 overflow-y-auto border-border/70 p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-[380px]">
          <SheetHeader className="border-b border-border/60 px-5 py-5 pr-12">
            <SheetTitle>账号与访问</SheetTitle>
            <SheetDescription>管理个人用量、安全会话与可用的管理入口。</SheetDescription>
          </SheetHeader>

          <div className="border-b border-border/60 p-4">
            <div className="flex items-center gap-3 rounded-xl bg-muted/55 p-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
                {initial}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{displayName}</p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              </div>
              <span className="rounded-full border border-border/70 bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground">
                {user.role === 'admin' ? '管理员' : '成员'}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              账号已安全登录
            </div>
          </div>

          <nav className="grid gap-1 p-4" aria-label="账号导航">
            {accountLinks.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <SheetClose asChild key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      buttonVariants({ variant: 'ghost' }),
                      'h-10 w-full justify-start rounded-lg px-3',
                      active && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </SheetClose>
              );
            })}
          </nav>

          <div className="mt-auto border-t border-border/60 p-4">
            <div className="mb-3 flex items-center justify-between sm:hidden">
              <span className="text-xs font-medium text-muted-foreground">界面主题</span>
              <ThemeToggle />
            </div>
            <Button
              className="w-full justify-start"
              variant="ghost"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                try {
                  await signOut();
                } finally {
                  setSigningOut(false);
                }
              }}
            >
              <LogOut className="h-4 w-4" />
              {signingOut ? '正在退出…' : '退出登录'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export { routeUsesIntegratedAccountNavigation };
export type { AuthUserMenuVariant };
