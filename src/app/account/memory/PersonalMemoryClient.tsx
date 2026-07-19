'use client';

import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Database,
  History,
  Pencil,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { AccountPageShell } from '@/components/account/AccountPageShell';
import { Button } from '@/components/ui/button';

interface MemoryPreference {
  recordId: string;
  revisionId: string;
  key: string;
  value: string;
  context: Record<string, string>;
  confidence: number;
  sequence: number;
  recordedAt: string;
  validFrom: string;
}

interface MemoryRevision {
  id: string;
  sequence: number;
  value: string;
  confidence: number;
  supportCount: number;
  contradictionCount: number;
  validFrom: string;
  recordedAt: string;
  supersedesRevisionId: string | null;
}

interface MemoryAccountState {
  control: {
    configured: boolean;
    personalizationEnabled: boolean;
    policyVersion: string;
    enabledAt: string | null;
    disabledAt: string | null;
  };
  integration: {
    configurationValid: boolean;
    enabled: boolean;
    required: boolean;
    requireProductionReady: boolean;
    status: 'disabled' | 'ready' | 'unavailable';
    error: string | null;
    service: {
      name: string;
      apiContract: string;
      authMode: string;
      productionReady: boolean;
      productionBlockers: string[];
    } | null;
  };
  preferences: MemoryPreference[] | null;
  valueSummary: {
    exposedRunCount: number;
    exposedRevisionReferenceCount: number;
    legacyEmptyAttributionCount: number;
    lastExposedAt: string | null;
    completedFeedbackCount: number;
    helpfulFeedbackCount: number;
    rejectedFeedbackCount: number;
    pendingFeedbackCount: number;
    failedFeedbackCount: number;
  };
  lifecycle: {
    productUsageFenceAvailable: boolean;
    providerErasureAvailable: boolean;
    notice: string;
  };
}

function integrationLabel(state: MemoryAccountState['integration']): string {
  if (!state.enabled || state.status === 'disabled') return '平台未启用';
  if (state.status === 'ready') return '连接正常';
  return '当前不可用';
}

export default function PersonalMemoryClient() {
  const [state, setState] = useState<MemoryAccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [correctionValue, setCorrectionValue] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [revisions, setRevisions] = useState<Record<string, MemoryRevision[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/account/memory', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '用户记忆状态加载失败。');
      setState(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '用户记忆状态加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setEnabled(enabled: boolean) {
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/account/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalizationEnabled: enabled }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '用户记忆设置保存失败。');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '用户记忆设置保存失败。');
    } finally {
      setSaving(false);
    }
  }

  async function submitCorrection(preference: MemoryPreference) {
    const value = correctionValue.trim();
    const reason = correctionReason.trim();
    if (!value || !reason) {
      setError('修正内容和修正原因都不能为空。');
      return;
    }
    setCorrecting(true);
    setError('');
    try {
      const response = await fetch(
        `/api/account/memory/preferences/${encodeURIComponent(preference.recordId)}/corrections`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId: `memory-correction:${crypto.randomUUID()}`,
            value,
            evidenceText: `用户在 QuantPilot 账号记忆中心明确修正：${value}`,
            reason,
            expectedRevisionId: preference.revisionId,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '偏好修正失败，请稍后重试。');
      setEditingId(null);
      setCorrectionValue('');
      setCorrectionReason('');
      setRevisions((current) => {
        const next = { ...current };
        delete next[preference.recordId];
        return next;
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '偏好修正失败，请稍后重试。');
    } finally {
      setCorrecting(false);
    }
  }

  async function toggleHistory(recordId: string) {
    if (historyId === recordId) {
      setHistoryId(null);
      return;
    }
    setHistoryId(recordId);
    if (revisions[recordId]) return;
    setHistoryLoading(true);
    setError('');
    try {
      const response = await fetch(
        `/api/account/memory/preferences/${encodeURIComponent(recordId)}/revisions`,
        { cache: 'no-store' },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '偏好历史加载失败。');
      setRevisions((current) => ({ ...current, [recordId]: payload.data as MemoryRevision[] }));
    } catch (cause) {
      setHistoryId(null);
      setError(cause instanceof Error ? cause.message : '偏好历史加载失败。');
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <AccountPageShell
      title="用户记忆"
      subtitle="决定外部记忆是否可以影响未来的 QuantPilot 任务，并查看当前保存的偏好。"
      contentClassName="max-w-5xl space-y-6"
      actions={(
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">刷新</span>
        </Button>
      )}
    >
      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-600">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
        </div>
      ) : null}

      {loading && !state ? (
        <div className="rounded-2xl border bg-card p-12 text-center text-sm text-muted-foreground shadow-sm">正在读取用户记忆设置…</div>
      ) : state ? (
        <>
          <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><BrainCircuit className="h-5 w-5" /></span>
                <div>
                  <h2 className="font-semibold">个性化使用开关</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                    启用后，QuantPilot 才会在新任务开始前召回你的分析、输出和研究偏好。关闭状态下不会向 Memory 发起任务召回。
                  </p>
                </div>
              </div>
              <Button
                variant={state.control.personalizationEnabled ? 'outline' : 'default'}
                disabled={
                  saving
                  || (!state.control.personalizationEnabled && !state.integration.enabled)
                }
                onClick={() => void setEnabled(!state.control.personalizationEnabled)}
              >
                {saving
                  ? '正在保存…'
                  : state.control.personalizationEnabled
                    ? '暂停个性化'
                    : '启用个性化'}
              </Button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">账号控制</p><p className="mt-1 text-sm font-semibold">{state.control.personalizationEnabled ? '已启用' : '已关闭'}</p></div>
              <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">服务连接</p><p className="mt-1 text-sm font-semibold">{integrationLabel(state.integration)}</p></div>
              <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">契约</p><p className="mt-1 truncate text-sm font-semibold">{state.integration.service?.apiContract ?? '—'}</p></div>
            </div>
          </section>

          <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              <div>
                <h2 className="font-semibold">实际价值闭环</h2>
                <p className="text-sm text-muted-foreground">只统计真正交付给 Agent 的偏好和你明确提交的反馈，不把普通召回计为价值。</p>
              </div>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">实际个性化任务</p><p className="mt-1 text-xl font-semibold">{state.valueSummary.exposedRunCount}</p></div>
              <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">偏好引用次数</p><p className="mt-1 text-xl font-semibold">{state.valueSummary.exposedRevisionReferenceCount}</p></div>
              <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">有帮助反馈</p><p className="mt-1 text-xl font-semibold text-emerald-700">{state.valueSummary.helpfulFeedbackCount}</p></div>
              <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">不适合反馈</p><p className="mt-1 text-xl font-semibold text-amber-700">{state.valueSummary.rejectedFeedbackCount}</p></div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              最近实际使用：{state.valueSummary.lastExposedAt ? new Date(state.valueSummary.lastExposedAt).toLocaleString('zh-CN') : '尚无'}
              {state.valueSummary.legacyEmptyAttributionCount > 0 ? ` · 已隔离 ${state.valueSummary.legacyEmptyAttributionCount} 条旧版空归因，不计入价值` : ''}
              {state.valueSummary.failedFeedbackCount > 0 ? ` · ${state.valueSummary.failedFeedbackCount} 条反馈等待重试` : ''}
            </p>
          </section>

          <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
            <div className="flex items-center gap-3"><Database className="h-5 w-5 text-primary" /><div><h2 className="font-semibold">当前偏好</h2><p className="text-sm text-muted-foreground">仅展示属于当前登录账号、且标记为 QuantPilot 的偏好。</p></div></div>
            <div className="mt-5 grid gap-3">
              {state.preferences?.map((preference) => (
                <article key={preference.recordId} className="rounded-xl border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2"><code className="text-xs font-semibold text-primary">{preference.key}</code><span className="text-xs text-muted-foreground">版本 {preference.sequence} · 置信度 {Math.round(preference.confidence * 100)}%</span></div>
                  <p className="mt-3 break-words text-sm leading-6">{preference.value}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{preference.context.project_id ? `项目级 · ${preference.context.project_id}` : '全局偏好'} · {new Date(preference.recordedAt).toLocaleString('zh-CN')}</p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!state.control.personalizationEnabled || correcting}
                        onClick={() => {
                          if (editingId === preference.recordId) {
                            setEditingId(null);
                          } else {
                            setEditingId(preference.recordId);
                            setCorrectionValue(preference.value);
                            setCorrectionReason('');
                          }
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />修正
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={historyLoading}
                        onClick={() => void toggleHistory(preference.recordId)}
                      >
                        <History className="h-3.5 w-3.5" />历史
                      </Button>
                    </div>
                  </div>

                  {editingId === preference.recordId ? (
                    <div className="mt-4 space-y-3 rounded-xl border bg-muted/30 p-3">
                      <label className="block space-y-1.5 text-xs font-medium">
                        修正后的偏好
                        <textarea
                          value={correctionValue}
                          onChange={(event) => setCorrectionValue(event.target.value)}
                          rows={4}
                          maxLength={4_096}
                          disabled={correcting}
                          className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-6"
                        />
                      </label>
                      <label className="block space-y-1.5 text-xs font-medium">
                        为什么要修正
                        <input
                          value={correctionReason}
                          onChange={(event) => setCorrectionReason(event.target.value)}
                          maxLength={2_048}
                          disabled={correcting}
                          placeholder="例如：原偏好过于简略"
                          className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                        />
                      </label>
                      <p className="text-xs leading-5 text-muted-foreground">修正会新增不可变版本；旧版本仍保留在审计历史中，不会被覆盖。</p>
                      <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="outline" disabled={correcting} onClick={() => setEditingId(null)}>取消</Button>
                        <Button type="button" size="sm" disabled={correcting || !correctionValue.trim() || !correctionReason.trim()} onClick={() => void submitCorrection(preference)}>
                          {correcting ? '修正中…' : '确认修正'}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {historyId === preference.recordId ? (
                    <div className="mt-4 rounded-xl border bg-muted/20 p-3">
                      <p className="text-xs font-semibold">不可变版本历史</p>
                      {historyLoading && !revisions[preference.recordId] ? (
                        <p className="mt-2 text-xs text-muted-foreground">正在读取…</p>
                      ) : (
                        <ol className="mt-3 space-y-3">
                          {(revisions[preference.recordId] ?? []).map((revision) => (
                            <li key={revision.id} className="border-l-2 border-primary/25 pl-3">
                              <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                                <span>版本 {revision.sequence} · 置信度 {Math.round(revision.confidence * 100)}%</span>
                                <time>{new Date(revision.recordedAt).toLocaleString('zh-CN')}</time>
                              </div>
                              <p className="mt-1 break-words text-sm leading-6">{revision.value}</p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  ) : null}
                </article>
              ))}
              {state.preferences?.length === 0 ? <p className="rounded-xl border border-dashed p-6 text-center text-sm leading-6 text-muted-foreground">还没有 QuantPilot 用户偏好。进入任一项目对话，在输入框下方点击“记住偏好”并明确确认后，偏好才会写入。</p> : null}
              {state.preferences === null ? <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">服务当前不可用，暂时无法读取偏好。</p> : null}
            </div>
          </section>

          <section className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-5 sm:p-6">
            <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" /><div><h2 className="font-semibold text-amber-800 dark:text-amber-200">关闭不等于删除</h2><p className="mt-2 text-sm leading-6 text-amber-800/80 dark:text-amber-200/80">{state.lifecycle.notice}</p></div></div>
            {state.integration.service?.productionReady ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-emerald-700"><CheckCircle2 className="h-4 w-4" />服务声明生产治理已就绪。</p>
            ) : (
              <p className="mt-3 text-xs text-amber-800/75 dark:text-amber-200/75">生产阻塞：{state.integration.service?.productionBlockers.join('、') || state.integration.error || '服务未声明完整生命周期能力'}</p>
            )}
          </section>
        </>
      ) : null}
    </AccountPageShell>
  );
}
