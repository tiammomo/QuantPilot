'use client';

import { KeyRound, Laptop, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';

import { AccountPageShell } from '@/components/account/AccountPageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';

interface AccountSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return '未知设备';
  if (/mobile|android|iphone|ipad/i.test(userAgent)) return '移动设备';
  if (/chrome/i.test(userAgent)) return 'Chrome 浏览器';
  if (/firefox/i.test(userAgent)) return 'Firefox 浏览器';
  if (/safari/i.test(userAgent)) return 'Safari 浏览器';
  return '浏览器会话';
}

export default function AccountSecurityClient({ required }: { required: boolean }) {
  const { user, refresh } = useAuth();
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadSessions = useCallback(async () => {
    const response = await fetch('/api/account/sessions', { cache: 'no-store' });
    const payload = await response.json();
    if (response.ok) setSessions(payload.data ?? []);
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '密码修改失败。');
      setFeedback({ type: 'success', message: '密码已修改，其他设备会话已经撤销。' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await refresh();
      window.setTimeout(() => window.location.assign('/'), 600);
    } catch (error) {
      setFeedback({ type: 'error', message: error instanceof Error ? error.message : '密码修改失败。' });
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeSession(sessionId: string) {
    const response = await fetch('/api/account/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (response.ok) await loadSessions();
  }

  async function revokeOthers() {
    const response = await fetch('/api/account/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allOthers: true }),
    });
    if (response.ok) await loadSessions();
  }

  return (
    <AccountPageShell
      title="密码与登录设备"
      subtitle={user?.email ? `管理密码与已登录设备 · ${user.email}` : '管理密码与已登录设备'}
      contentClassName="max-w-4xl space-y-6"
    >
      {(required || user?.mustChangePassword) ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
          当前使用的是初始密码。修改密码后才能进入其他 QuantPilot 功能。
        </div>
      ) : null}

      <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><KeyRound className="h-5 w-5" /></span>
          <div><h2 className="font-semibold">修改密码</h2><p className="text-sm text-muted-foreground">至少 12 个字符，修改后撤销其他设备会话。</p></div>
        </div>
        <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={changePassword}>
          <div className="space-y-2 sm:col-span-2"><Label htmlFor="current-password">当前密码</Label><Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></div>
          <div className="space-y-2"><Label htmlFor="new-password">新密码</Label><Input id="new-password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></div>
          <div className="space-y-2"><Label htmlFor="confirm-password">确认新密码</Label><Input id="confirm-password" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div>
          {feedback ? <p role="status" className={`text-sm sm:col-span-2 ${feedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>{feedback.message}</p> : null}
          <div className="sm:col-span-2"><Button type="submit" disabled={submitting}>{submitting ? '正在修改…' : '修改密码'}</Button></div>
        </form>
      </section>

      <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600"><ShieldCheck className="h-5 w-5" /></span><div><h2 className="font-semibold">活跃会话</h2><p className="text-sm text-muted-foreground">管理已登录的浏览器和设备。</p></div></div>
          <Button variant="outline" size="sm" className="self-start sm:self-auto" onClick={revokeOthers}>撤销其他会话</Button>
        </div>
        <div className="mt-5 divide-y rounded-xl border">
          {sessions.map((session) => {
            const mobile = /mobile|android|iphone|ipad/i.test(session.userAgent ?? '');
            const DeviceIcon = mobile ? Smartphone : Laptop;
            return (
              <div key={session.id} className="flex items-center gap-3 p-4">
                <DeviceIcon className="h-5 w-5 text-muted-foreground" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{deviceLabel(session.userAgent)} {session.isCurrent ? '· 当前会话' : ''}</p><p className="text-xs text-muted-foreground">{session.ipAddress || 'IP 未记录'} · {new Date(session.updatedAt).toLocaleString('zh-CN')}</p></div>
                {!session.isCurrent ? <Button variant="ghost" size="sm" onClick={() => revokeSession(session.id)}><LogOut className="h-4 w-4" />撤销</Button> : null}
              </div>
            );
          })}
          {sessions.length === 0 ? <p className="p-4 text-sm text-muted-foreground">没有可展示的活跃会话。</p> : null}
        </div>
      </section>
    </AccountPageShell>
  );
}
