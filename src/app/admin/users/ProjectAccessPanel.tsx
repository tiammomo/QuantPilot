'use client';

import { FolderKanban, UserPlus } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ProjectSummary {
  id: string;
  name: string;
}

interface ProjectMember {
  id: string;
  role: 'owner' | 'editor' | 'viewer';
  user: { id: string; name: string; email: string; banned: boolean };
}

export default function ProjectAccessPanel() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(false);

  const loadMembers = useCallback(async (nextProjectId: string) => {
    if (!nextProjectId) {
      setOwnerId(null);
      setMembers([]);
      return;
    }
    setLoading(true);
    setFeedback('');
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(nextProjectId)}/members`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '项目成员加载失败。');
      setOwnerId(payload.data.ownerId);
      setMembers(payload.data.memberships ?? []);
    } catch (cause) {
      setOwnerId(null);
      setMembers([]);
      setFeedback(cause instanceof Error ? cause.message : '项目成员加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetch('/api/projects', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        const nextProjects = payload.data ?? [];
        setProjects(nextProjects);
        if (nextProjects[0]?.id) {
          setProjectId(nextProjects[0].id);
          void loadMembers(nextProjects[0].id);
        }
      })
      .catch(() => setFeedback('项目列表加载失败。'));
  }, [loadMembers]);

  async function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback('');
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    try {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '成员授权失败。');
      setEmail('');
      setFeedback('项目权限已更新。');
      await loadMembers(projectId);
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : '成员授权失败。');
    }
  }

  async function removeMember(userId: string) {
    if (!window.confirm('确认移除这个项目成员？')) return;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '移除成员失败。');
      await loadMembers(projectId);
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : '移除成员失败。');
    }
  }

  return (
    <section className="rounded-2xl border bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 font-semibold"><FolderKanban className="h-4 w-4" />项目成员与权限</div>
        <select className="h-9 min-w-64 rounded-md border bg-background px-3 text-sm" value={projectId} onChange={(event) => { setProjectId(event.target.value); void loadMembers(event.target.value); }}>
          {projects.length === 0 ? <option value="">暂无可管理项目</option> : null}
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.id}</option>)}
        </select>
      </div>
      <div className="grid gap-5 p-4 lg:grid-cols-[340px_1fr]">
        <form className="space-y-3 rounded-xl border bg-muted/20 p-4" onSubmit={saveMember}>
          <div className="flex items-center gap-2 font-medium"><UserPlus className="h-4 w-4" />添加或更新成员</div>
          <Input type="email" placeholder="成员邮箱" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={role} onChange={(event) => setRole(event.target.value as 'editor' | 'viewer')}><option value="viewer">只读查看者</option><option value="editor">项目编辑者</option></select>
          <Button type="submit" className="w-full" disabled={!projectId || loading}>{loading ? '正在处理…' : '保存项目权限'}</Button>
          {feedback ? <p role="status" className="text-xs text-muted-foreground">{feedback}</p> : null}
        </form>
        <div className="divide-y rounded-xl border">
          {members.map((member) => (
            <div key={member.id} className="flex items-center gap-3 p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.user.name} · {member.user.email}</p><p className="mt-1 text-xs text-muted-foreground">{member.role === 'owner' ? '项目所有者' : member.role === 'editor' ? '可编辑' : '只读'}{member.user.banned ? ' · 账号已停用' : ''}</p></div>{member.user.id !== ownerId ? <Button variant="ghost" size="sm" className="text-red-600" onClick={() => removeMember(member.user.id)}>移除</Button> : null}</div>
          ))}
          {members.length === 0 ? <p className="p-4 text-sm text-muted-foreground">这个项目还没有成员记录。</p> : null}
        </div>
      </div>
    </section>
  );
}
