'use client';

import { Gauge, KeyRound, LogOut, ShieldCheck, UserRound, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

export function AuthUserMenu() {
  const { enabled, user, isPending, signOut } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const isIntegratedNavigationRoute = pathname === '/' || pathname?.startsWith('/account/') || /^\/[^/]+\/chat\/?$/.test(pathname ?? '');
  if (!enabled || isPending || !user || isIntegratedNavigationRoute) return null;
  const initial = (user.name || user.email).slice(0, 1).toUpperCase();

  return (
    <div className="fixed bottom-4 right-4 z-[90] flex flex-col items-end gap-2">
      {open ? (
        <div className="w-72 rounded-2xl border border-border/70 bg-background/95 p-3 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-3 rounded-xl bg-muted/55 p-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              {initial}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            数据库会话已验证
          </div>
          <Button className="mt-2 w-full justify-start" variant="ghost" asChild>
            <Link href="/account/security">
              <KeyRound className="h-4 w-4" />
              账号与会话
            </Link>
          </Button>
          <Button className="w-full justify-start" variant="ghost" asChild>
            <Link href="/account/usage">
              <Gauge className="h-4 w-4" />
              用量与配额
            </Link>
          </Button>
          {user.role === 'admin' ? (
            <Button className="w-full justify-start" variant="ghost" asChild>
              <Link href="/admin/users">
                <Users className="h-4 w-4" />
                用户管理
              </Link>
            </Button>
          ) : null}
          <Button
            className="w-full justify-start"
            variant="ghost"
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true);
              await signOut();
            }}
          >
            <LogOut className="h-4 w-4" />
            {signingOut ? '正在退出…' : '退出登录'}
          </Button>
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="h-11 rounded-full border-border/70 bg-background/90 px-3 shadow-lg backdrop-blur-xl"
        aria-label={open ? '收起账号菜单' : '打开账号菜单'}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {initial || <UserRound className="h-4 w-4" />}
        </span>
        <span className="max-w-28 truncate">{user.name}</span>
      </Button>
    </div>
  );
}
