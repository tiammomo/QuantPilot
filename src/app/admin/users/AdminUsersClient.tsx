'use client';

import { Ban, KeyRound, RefreshCw, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AccessQuotaPanel from './AccessQuotaPanel';
import SecurityAuditPanel from './SecurityAuditPanel';
import ProjectAccessPanel from './ProjectAccessPanel';

interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  banned: boolean;
  banReason: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  _count: {
    sessions: number;
    projectMemberships: number;
    ownedProjects: number;
  };
}

interface CredentialNotice {
  email: string;
  password: string;
}

export default function AdminUsersClient({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [credential, setCredential] = useState<CredentialNotice | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [submitting, setSubmitting] = useState(false);

  const loadUsers = useCallback(async (search = '') => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/admin/users?q=${encodeURIComponent(search)}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '用户列表加载失败。');
      setUsers(payload.data?.users ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '用户列表加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers('');
  }, [loadUsers]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, role }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '用户创建失败。');
      setCredential({ email: payload.data.email, password: payload.data.initialPassword });
      setName('');
      setEmail('');
      setRole('member');
      await loadUsers('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '用户创建失败。');
    } finally {
      setSubmitting(false);
    }
  }

  async function updateUser(body: Record<string, unknown>, confirmMessage?: string) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setError('');
    const response = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.message || '操作失败。');
      return;
    }
    if (body.action === 'reset-password') {
      const target = users.find((user) => user.id === body.userId);
      setCredential({ email: target?.email || '', password: payload.data.initialPassword });
    }
    await loadUsers(query);
  }

  return (
    <main className="min-h-screen bg-muted/25 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div><p className="text-sm font-medium text-primary">平台治理</p><h1 className="mt-1 text-3xl font-bold tracking-tight">用户管理</h1><p className="mt-2 text-sm text-muted-foreground">创建、停用、授权并撤销用户会话。</p></div>
          <Button variant="outline" onClick={() => loadUsers(query)}><RefreshCw className="h-4 w-4" />刷新</Button>
        </header>

        {credential ? (
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex items-start justify-between gap-4"><div><p className="font-semibold text-amber-800 dark:text-amber-200">一次性初始凭据</p><p className="mt-1 text-sm text-amber-700 dark:text-amber-300">请通过安全渠道发送，离开页面后不再展示。</p><div className="mt-3 rounded-lg bg-background/80 px-3 py-2 font-mono text-sm">{credential.email} / {credential.password}</div></div><Button variant="ghost" size="sm" onClick={() => setCredential(null)}>关闭</Button></div>
          </section>
        ) : null}

        {error ? <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-600">{error}</div> : null}

        <section className="grid gap-6 lg:grid-cols-[340px_1fr]">
          <form onSubmit={createUser} className="h-fit rounded-2xl border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><UserPlus className="h-5 w-5" /></span><div><h2 className="font-semibold">创建用户</h2><p className="text-xs text-muted-foreground">自动生成强初始密码</p></div></div>
            <div className="mt-5 space-y-4">
              <div className="space-y-2"><Label htmlFor="new-user-name">姓名</Label><Input id="new-user-name" value={name} onChange={(event) => setName(event.target.value)} required /></div>
              <div className="space-y-2"><Label htmlFor="new-user-email">邮箱</Label><Input id="new-user-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
              <div className="space-y-2"><Label htmlFor="new-user-role">平台角色</Label><select id="new-user-role" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={role} onChange={(event) => setRole(event.target.value as 'member' | 'admin')}><option value="member">普通成员</option><option value="admin">平台管理员</option></select></div>
              <Button className="w-full" type="submit" disabled={submitting}>{submitting ? '正在创建…' : '创建用户'}</Button>
            </div>
          </form>

          <div className="min-w-0 rounded-2xl border bg-card shadow-sm">
            <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-2 font-semibold"><Users className="h-4 w-4" />用户列表</div><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void loadUsers(query); }}><Input className="w-56" placeholder="搜索姓名或邮箱" value={query} onChange={(event) => setQuery(event.target.value)} /><Button type="submit" variant="outline">搜索</Button></form></div>
            <div className="platform-nav-scroll overflow-x-auto overscroll-x-contain touch-pan-x [scrollbar-gutter:stable]">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3">用户</th><th className="px-4 py-3">角色/状态</th><th className="px-4 py-3">项目</th><th className="px-4 py-3">会话</th><th className="px-4 py-3 text-right">操作</th></tr></thead>
                <tbody className="divide-y">
                  {users.map((user) => {
                    const self = user.id === currentUserId;
                    return (
                      <tr key={user.id} className="align-top">
                        <td className="px-4 py-4"><p className="font-medium">{user.name}{self ? '（你）' : ''}</p><p className="mt-1 text-xs text-muted-foreground">{user.email}</p>{user.lastLoginAt ? <p className="mt-1 text-xs text-muted-foreground">最近登录 {new Date(user.lastLoginAt).toLocaleString('zh-CN')}</p> : null}</td>
                        <td className="px-4 py-4"><span className={`inline-flex rounded-full px-2 py-1 text-xs ${user.role === 'admin' ? 'bg-violet-500/10 text-violet-600' : 'bg-slate-500/10 text-slate-600'}`}>{user.role === 'admin' ? '管理员' : '成员'}</span><span className={`ml-2 inline-flex rounded-full px-2 py-1 text-xs ${user.banned ? 'bg-red-500/10 text-red-600' : 'bg-emerald-500/10 text-emerald-600'}`}>{user.banned ? '已停用' : '正常'}</span>{user.mustChangePassword ? <p className="mt-2 text-xs text-amber-600">等待首次改密</p> : null}</td>
                        <td className="px-4 py-4 text-muted-foreground">拥有 {user._count.ownedProjects} · 参与 {user._count.projectMemberships}</td>
                        <td className="px-4 py-4 text-muted-foreground">{user._count.sessions} 个</td>
                        <td className="px-4 py-4"><div className="flex flex-wrap justify-end gap-1">
                          <Button variant="ghost" size="sm" disabled={self} onClick={() => updateUser({ action: 'set-role', userId: user.id, role: user.role === 'admin' ? 'member' : 'admin' }, `确认修改 ${user.email} 的角色？`)}><ShieldCheck className="h-4 w-4" />{user.role === 'admin' ? '降为成员' : '设为管理员'}</Button>
                          <Button variant="ghost" size="sm" onClick={() => updateUser({ action: 'reset-password', userId: user.id }, `确认重置 ${user.email} 的密码并撤销会话？`)}><KeyRound className="h-4 w-4" />重置密码</Button>
                          <Button variant="ghost" size="sm" onClick={() => updateUser({ action: 'revoke-sessions', userId: user.id }, `确认撤销 ${user.email} 的全部会话？`)}>撤销会话</Button>
                          <Button variant="ghost" size="sm" disabled={self} className={user.banned ? 'text-emerald-600' : 'text-red-600'} onClick={() => updateUser({ action: 'set-status', userId: user.id, banned: !user.banned }, `确认${user.banned ? '恢复' : '停用'} ${user.email}？`)}><Ban className="h-4 w-4" />{user.banned ? '恢复' : '停用'}</Button>
                        </div></td>
                      </tr>
                    );
                  })}
                  {!loading && users.length === 0 ? <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">没有匹配的用户。</td></tr> : null}
                </tbody>
              </table>
            </div>
            {loading ? <p className="p-6 text-center text-sm text-muted-foreground">正在加载用户…</p> : null}
          </div>
        </section>
        <AccessQuotaPanel users={users} currentUserId={currentUserId} />
        <ProjectAccessPanel />
        <SecurityAuditPanel />
      </div>
    </main>
  );
}
