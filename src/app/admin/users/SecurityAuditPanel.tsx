'use client';

import { ClipboardList, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

interface AuditEvent {
  id: string;
  eventType: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  ipAddress: string | null;
  createdAt: string;
  actor: { id: string; name: string; email: string } | null;
}

export default function SecurityAuditPanel() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/audit?limit=50', { cache: 'no-store' });
      const payload = await response.json();
      if (response.ok) setEvents(payload.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-2 font-semibold"><ClipboardList className="h-4 w-4" />安全审计</div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" />刷新</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3">时间</th><th className="px-4 py-3">事件</th><th className="px-4 py-3">操作者</th><th className="px-4 py-3">目标</th><th className="px-4 py-3">结果/IP</th></tr></thead>
          <tbody className="divide-y">
            {events.map((event) => (
              <tr key={event.id}><td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString('zh-CN')}</td><td className="px-4 py-3 font-mono text-xs">{event.eventType}</td><td className="px-4 py-3">{event.actor ? <><p>{event.actor.name}</p><p className="text-xs text-muted-foreground">{event.actor.email}</p></> : <span className="text-muted-foreground">匿名/系统</span>}</td><td className="px-4 py-3 text-xs text-muted-foreground">{event.targetType || '—'}{event.targetId ? ` · ${event.targetId.slice(0, 28)}` : ''}</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs ${event.outcome === 'success' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-600'}`}>{event.outcome}</span><p className="mt-1 text-xs text-muted-foreground">{event.ipAddress || 'IP 未记录'}</p></td></tr>
            ))}
            {!loading && events.length === 0 ? <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">暂无安全审计事件。</td></tr> : null}
          </tbody>
        </table>
      </div>
      {loading ? <p className="p-5 text-center text-sm text-muted-foreground">正在加载审计记录…</p> : null}
    </section>
  );
}
