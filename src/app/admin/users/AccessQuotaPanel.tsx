'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Infinity as InfinityIcon,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface AccessPanelUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  banned: boolean;
}

type PermissionScope = 'account' | 'project' | 'platform';
type PermissionEffect = 'allow' | 'deny';
type QuotaEnforcement = 'observe' | 'warn' | 'hard';
type QuotaWindow = 'minute' | 'hour' | 'day' | 'month' | 'fixed' | 'lifetime';

interface CatalogAction {
  key: string;
  scope: PermissionScope;
  description: string;
}

interface PermissionProfile {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  grants: Array<{ permissionKey: string; effect: PermissionEffect }>;
}

interface QuotaProfile {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  rules: Array<{
    metric: string;
    limit: string;
    enforcement: QuotaEnforcement;
    windowType: QuotaWindow;
    windowSeconds: number | null;
    reservationTtlSeconds: number;
  }>;
}

interface AccessCatalog {
  actions: CatalogAction[];
  permissionProfiles: PermissionProfile[];
  quotaProfiles: QuotaProfile[];
}

interface EffectivePermission extends Omit<CatalogAction, 'key'> {
  action: string;
  allowed: boolean;
  source: string;
  projectRoleRequired: boolean;
}

interface EffectiveQuota {
  metric: string;
  source: string;
  unlimited: boolean;
  enforcement: QuotaEnforcement;
  limit: string | null;
  used: string;
  reserved: string;
  remaining: string | null;
  exceeded: boolean;
  windowType: QuotaWindow;
  windowStart: string;
  windowEnd: string;
}

interface PermissionOverrideDraft {
  permissionKey: string;
  effect: PermissionEffect;
  expiresAt?: string | null;
}

interface QuotaOverrideDraft {
  metric: string;
  isUnlimited: boolean;
  limit: string | null;
  enforcement: QuotaEnforcement;
  windowType: QuotaWindow;
  windowSeconds?: number | null;
  reservationTtlSeconds?: number;
  expiresAt?: string | null;
}

interface UserAccessDetails {
  user: {
    id: string;
    name: string;
    email: string;
    role: 'admin' | 'member';
    isAdmin: boolean;
    accessVersion: number;
  };
  permissionProfile: { id: string; key: string; name: string } | null;
  quotaProfile: { id: string; key: string; name: string } | null;
  permissions: EffectivePermission[];
  permissionOverrides: Array<PermissionOverrideDraft & { reason: string | null }>;
  quotas: EffectiveQuota[];
  quotaOverrides: Array<QuotaOverrideDraft & { reason: string | null }>;
}

const SCOPE_META: Record<PermissionScope, { label: string; description: string }> = {
  account: { label: '账号能力', description: '适用于当前账号的研究、策略与数据能力。' },
  project: { label: '项目能力', description: '还会与项目中的 owner / editor / viewer 角色共同校验。' },
  platform: { label: '平台治理', description: '涉及全平台配置、审计与用户治理的高权限能力。' },
};

const ACTION_LABELS: Record<string, string> = {
  'project.create': '创建项目',
  'project.read': '查看项目',
  'project.update': '修改项目',
  'project.delete': '删除项目',
  'project.members.manage': '管理项目成员',
  'project.source.read': '读取项目源码',
  'project.source.write': '修改项目源码',
  'project.secrets.read': '读取项目密钥',
  'project.secrets.write': '管理项目密钥',
  'project.services.read': '查看项目服务',
  'project.services.manage': '管理项目服务',
  'project.deploy': '部署项目',
  'agent.run': '运行智能体',
  'agent.cancel': '取消智能体运行',
  'quant.data.read': '查询量化数据',
  'quant.query.rewrite.llm': '使用 LLM 改写查询',
  'quant.strategy.run': '运行量化策略',
  'quant.strategy.manage': '管理量化策略',
  'research.report.read': '查看研究报告',
  'research.report.run': '生成研究报告',
  'research.report.send': '发送或发布报告',
  'platform.users.manage': '管理平台用户',
  'platform.quotas.manage': '管理权限与配额',
  'platform.audit.read': '查看安全审计',
  'platform.observability.read': '查看平台可观测数据',
  'platform.settings.manage': '管理平台设置',
  'platform.tokens.manage': '管理平台令牌',
};

const METRIC_LABELS: Record<string, string> = {
  'projects.owned': '拥有项目数',
  'agent.pending': '智能体排队数',
  'agent.concurrent': '智能体并发数',
  'agent.requests.daily': '智能体每日请求',
  'llm.total_tokens.monthly': 'LLM 每月 Token',
  'query_rewrite.llm.daily': 'LLM 查询改写次数',
  'quant.data_units.daily': '量化数据单元',
  'research.report_runs.daily': '研究报告生成次数',
  'research.report_sends.daily': '研究报告发送次数',
};

const WINDOW_LABELS: Record<QuotaWindow, string> = {
  minute: '每分钟',
  hour: '每小时',
  day: '每天',
  month: '每月',
  fixed: '固定窗口',
  lifetime: '永久累计',
};

const ENFORCEMENT_LABELS: Record<QuotaEnforcement, string> = {
  observe: '仅观测',
  warn: '接近时提醒',
  hard: '达到后阻止',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

function formatAmount(value: string | null): string {
  if (value === null) return '∞';
  try {
    return BigInt(value).toLocaleString('zh-CN');
  } catch {
    return value;
  }
}

function quotaPercent(quota: EffectiveQuota): number {
  if (!quota.limit || quota.limit === '0') return 0;
  try {
    const consumed = BigInt(quota.used) + BigInt(quota.reserved);
    const basisPoints = (consumed * 10_000n) / BigInt(quota.limit);
    return Math.min(100, Number(basisPoints) / 100);
  } catch {
    return 0;
  }
}

function resetLabel(quota: EffectiveQuota): string {
  if (quota.windowType === 'lifetime') return '不重置';
  const date = new Date(quota.windowEnd);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN');
}

function sourceLabel(source: string): string {
  if (source === 'administrator') return '管理员默认授权';
  if (source === 'not-granted') return '未授权';
  if (source.startsWith('user-override:allow')) return '用户覆盖：允许';
  if (source.startsWith('user-override:deny')) return '用户覆盖：拒绝';
  if (source.startsWith('profile:')) return '权限模板';
  if (source === 'user-override' || source === 'user_override') return '用户配额覆盖';
  if (source === 'admin_unlimited') return '管理员不限额';
  if (source === 'profile') return '配额模板';
  if (source === 'default_profile') return '默认配额模板';
  if (source === 'builtin-default') return '内置默认配额';
  if (source === 'unconfigured') return '未配置（仅观测）';
  return source.replaceAll('_', ' ');
}

function permissionDrafts(details: UserAccessDetails): Record<string, PermissionOverrideDraft> {
  return Object.fromEntries(details.permissionOverrides.map((override) => [
    override.permissionKey,
    {
      permissionKey: override.permissionKey,
      effect: override.effect,
      expiresAt: override.expiresAt,
    },
  ]));
}

function quotaDrafts(details: UserAccessDetails): Record<string, QuotaOverrideDraft> {
  return Object.fromEntries(details.quotaOverrides.map((override) => [
    override.metric,
    {
      metric: override.metric,
      isUnlimited: override.isUnlimited,
      limit: override.limit,
      enforcement: override.enforcement,
      windowType: override.windowType,
      windowSeconds: override.windowSeconds,
      reservationTtlSeconds: override.reservationTtlSeconds,
      expiresAt: override.expiresAt,
    },
  ]));
}

export default function AccessQuotaPanel({
  users,
  currentUserId,
}: {
  users: AccessPanelUser[];
  currentUserId: string;
}) {
  const [catalog, setCatalog] = useState<AccessCatalog | null>(null);
  const [selectedUserId, setSelectedUserId] = useState(currentUserId);
  const [details, setDetails] = useState<UserAccessDetails | null>(null);
  const [permissionProfileId, setPermissionProfileId] = useState('');
  const [quotaProfileId, setQuotaProfileId] = useState('');
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, PermissionOverrideDraft>>({});
  const [quotaOverrides, setQuotaOverrides] = useState<Record<string, QuotaOverrideDraft>>({});
  const [reason, setReason] = useState('');
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (users.some((user) => user.id === selectedUserId)) return;
    setSelectedUserId(users.find((user) => user.id === currentUserId)?.id ?? users[0]?.id ?? '');
  }, [currentUserId, selectedUserId, users]);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const response = await fetch('/api/admin/access-control', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '权限与配额模板加载失败。');
      setCatalog(payload.data);
    } catch (error) {
      setFeedback({ type: 'error', message: error instanceof Error ? error.message : '权限与配额模板加载失败。' });
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  const loadDetails = useCallback(async (userId: string) => {
    if (!userId) {
      setDetails(null);
      return;
    }
    setLoadingDetails(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/access`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '用户权限与配额加载失败。');
      const nextDetails = payload.data as UserAccessDetails;
      setDetails(nextDetails);
      setPermissionProfileId(nextDetails.permissionProfile?.id ?? '');
      setQuotaProfileId(nextDetails.quotaProfile?.id ?? '');
      setPermissionOverrides(permissionDrafts(nextDetails));
      setQuotaOverrides(quotaDrafts(nextDetails));
      setReason('');
    } catch (error) {
      setDetails(null);
      setFeedback({ type: 'error', message: error instanceof Error ? error.message : '用户权限与配额加载失败。' });
    } finally {
      setLoadingDetails(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    void loadDetails(selectedUserId);
  }, [loadDetails, selectedUserId]);

  const actionsByScope = useMemo(() => {
    const actions = catalog?.actions ?? [];
    return (['account', 'project', 'platform'] as const).map((scope) => ({
      scope,
      actions: actions.filter((action) => action.scope === scope),
    }));
  }, [catalog]);

  const effectivePermissionByAction = useMemo(
    () => new Map(details?.permissions.map((permission) => [permission.action, permission]) ?? []),
    [details],
  );

  const effectiveQuotaByMetric = useMemo(
    () => new Map(details?.quotas.map((quota) => [quota.metric, quota]) ?? []),
    [details],
  );

  const quotaMetrics = useMemo(() => {
    const metrics = new Set<string>(details?.quotas.map((quota) => quota.metric) ?? []);
    for (const profile of catalog?.quotaProfiles ?? []) {
      for (const rule of profile.rules) metrics.add(rule.metric);
    }
    return [...metrics].sort();
  }, [catalog, details]);

  const admin = details?.user.isAdmin ?? false;

  function changePermissionOverride(permissionKey: string, value: 'inherit' | PermissionEffect) {
    setPermissionOverrides((current) => {
      if (value === 'inherit') {
        const next = { ...current };
        delete next[permissionKey];
        return next;
      }
      return {
        ...current,
        [permissionKey]: {
          permissionKey,
          effect: value,
          expiresAt: current[permissionKey]?.expiresAt ?? null,
        },
      };
    });
  }

  function toggleQuotaOverride(metric: string) {
    setQuotaOverrides((current) => {
      if (current[metric]) {
        const next = { ...current };
        delete next[metric];
        return next;
      }
      const quota = effectiveQuotaByMetric.get(metric);
      const catalogRule = catalog?.quotaProfiles.flatMap((profile) => profile.rules).find((rule) => rule.metric === metric);
      return {
        ...current,
        [metric]: {
          metric,
          isUnlimited: quota?.unlimited ?? false,
          limit: quota?.limit ?? catalogRule?.limit ?? '1',
          enforcement: quota?.enforcement ?? catalogRule?.enforcement ?? 'observe',
          windowType: quota?.windowType ?? catalogRule?.windowType ?? 'month',
          windowSeconds: catalogRule?.windowSeconds ?? null,
          reservationTtlSeconds: catalogRule?.reservationTtlSeconds ?? 900,
          expiresAt: null,
        },
      };
    });
  }

  function updateQuotaOverride(metric: string, patch: Partial<QuotaOverrideDraft>) {
    setQuotaOverrides((current) => {
      const existing = current[metric];
      if (!existing) return current;
      return { ...current, [metric]: { ...existing, ...patch } };
    });
  }

  async function saveChanges() {
    if (!details || admin) return;
    if (reason.trim().length < 3) {
      setFeedback({ type: 'error', message: '请填写至少 3 个字符的变更原因，便于后续审计。' });
      return;
    }
    for (const override of Object.values(quotaOverrides)) {
      if (!override.isUnlimited && (!/^\d+$/.test(override.limit ?? '') || BigInt(override.limit ?? '0') <= 0n)) {
        setFeedback({ type: 'error', message: `${metricLabel(override.metric)} 的上限必须是正整数。` });
        return;
      }
    }

    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(details.user.id)}/access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedAccessVersion: details.user.accessVersion,
          reason: reason.trim(),
          permissionProfileId: permissionProfileId || null,
          quotaProfileId: quotaProfileId || null,
          permissionOverrides: Object.values(permissionOverrides),
          quotaOverrides: Object.values(quotaOverrides).map((override) => ({
            ...override,
            limit: override.isUnlimited ? null : override.limit,
            ...(override.windowType === 'fixed' ? {} : { windowSeconds: undefined }),
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '权限与配额保存失败。');
      const nextDetails = payload.data as UserAccessDetails;
      setDetails(nextDetails);
      setPermissionProfileId(nextDetails.permissionProfile?.id ?? '');
      setQuotaProfileId(nextDetails.quotaProfile?.id ?? '');
      setPermissionOverrides(permissionDrafts(nextDetails));
      setQuotaOverrides(quotaDrafts(nextDetails));
      setReason('');
      setFeedback({ type: 'success', message: '权限与配额已保存，并记录到安全审计。' });
    } catch (error) {
      setFeedback({ type: 'error', message: error instanceof Error ? error.message : '权限与配额保存失败。' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="access-quota" className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="border-b bg-gradient-to-r from-primary/[0.07] via-background to-cyan-500/[0.05] p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <SlidersHorizontal className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">权限与使用配额</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                模板负责常规授权，单项覆盖只用于例外。所有修改都要求说明原因并写入审计日志。
              </p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
            <div className="min-w-0 sm:min-w-72">
              <Label htmlFor="access-user" className="sr-only">选择用户</Label>
              <select
                id="access-user"
                className="h-10 w-full rounded-lg border bg-background px-3 text-sm shadow-sm outline-none focus:ring-2 focus:ring-primary/20"
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} · {user.email}{user.role === 'admin' ? '（管理员）' : ''}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!selectedUserId || loadingDetails || loadingCatalog}
              onClick={() => {
                void Promise.all([loadCatalog(), loadDetails(selectedUserId)]);
              }}
            >
              <RefreshCw className={`h-4 w-4 ${loadingDetails || loadingCatalog ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>
        </div>
      </div>

      {feedback ? (
        <div
          role="status"
          className={`mx-5 mt-5 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm sm:mx-6 ${
            feedback.type === 'success'
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-red-500/25 bg-red-500/10 text-red-600'
          }`}
        >
          {feedback.type === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          {feedback.message}
        </div>
      ) : null}

      {loadingDetails && !details ? (
        <div className="p-12 text-center text-sm text-muted-foreground">正在加载用户的有效权限与用量…</div>
      ) : details ? (
        <div className="space-y-8 p-5 sm:p-6">
          <div className={`rounded-2xl border p-4 ${admin ? 'border-violet-500/25 bg-violet-500/[0.07]' : 'bg-muted/20'}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-semibold">{details.user.name}</p>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${admin ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-primary/10 text-primary'}`}>
                    {admin ? '平台管理员' : '普通成员'}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">{details.user.email}</p>
              </div>
              {admin ? (
                <div className="flex items-center gap-2 rounded-xl bg-background/75 px-4 py-2 font-semibold text-violet-700 shadow-sm dark:text-violet-300">
                  <ShieldCheck className="h-4 w-4" />
                  全部权限 · 配额 <InfinityIcon className="h-5 w-5" />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">策略版本 {details.user.accessVersion}</p>
              )}
            </div>
            {admin ? (
              <p className="mt-3 text-xs text-muted-foreground">管理员策略固定为全部权限和无限配额；下方仍展示真实使用量，数值编辑已禁用。</p>
            ) : null}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="permission-profile">权限模板</Label>
              <select
                id="permission-profile"
                className="h-10 w-full rounded-lg border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                value={permissionProfileId}
                disabled={admin || saving}
                onChange={(event) => setPermissionProfileId(event.target.value)}
              >
                <option value="">平台默认权限模板</option>
                {catalog?.permissionProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}{profile.isDefault ? '（默认）' : ''}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">先选择最接近职责的模板，再用少量单项覆盖处理例外。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="quota-profile">配额模板</Label>
              <select
                id="quota-profile"
                className="h-10 w-full rounded-lg border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                value={quotaProfileId}
                disabled={admin || saving}
                onChange={(event) => setQuotaProfileId(event.target.value)}
              >
                <option value="">平台默认模板</option>
                {catalog?.quotaProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}{profile.isDefault ? '（默认）' : ''}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">配额覆盖会优先于模板；硬限制达到上限后会拒绝新请求。</p>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h3 className="font-semibold">有效权限</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">表格支持触控左右滑动；修改模板后，有效状态将在保存并重新计算后更新。</p>

            <div className="mt-4 space-y-5">
              {actionsByScope.map(({ scope, actions }) => (
                <div key={scope} className="overflow-hidden rounded-xl border">
                  <div className="border-b bg-muted/35 px-4 py-3">
                    <p className="text-sm font-semibold">{SCOPE_META[scope].label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{SCOPE_META[scope].description}</p>
                  </div>
                  <div className="platform-nav-scroll overflow-x-auto overscroll-x-contain touch-pan-x [scrollbar-gutter:stable]">
                    <table className="w-full min-w-[760px] text-left text-sm">
                      <thead className="bg-muted/20 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-4 py-2.5 font-medium">能力</th>
                          <th className="w-28 px-4 py-2.5 font-medium">当前有效</th>
                          <th className="w-44 px-4 py-2.5 font-medium">授权来源</th>
                          <th className="w-48 px-4 py-2.5 font-medium">单项覆盖</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {actions.map((action) => {
                          const effective = effectivePermissionByAction.get(action.key);
                          const override = permissionOverrides[action.key];
                          return (
                            <tr key={action.key} className="align-middle">
                              <td className="px-4 py-3">
                                <p className="font-medium">{actionLabel(action.key)}</p>
                                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{action.key}</p>
                              </td>
                              <td className="px-4 py-3">
                                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${
                                  effective?.allowed
                                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                    : 'bg-slate-500/10 text-slate-600 dark:text-slate-300'
                                }`}>
                                  {effective?.allowed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                                  {effective?.allowed ? '允许' : '拒绝'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-xs text-muted-foreground">{sourceLabel(effective?.source ?? 'not-granted')}</td>
                              <td className="px-4 py-3">
                                <select
                                  aria-label={`${actionLabel(action.key)}单项覆盖`}
                                  className="h-8 w-full rounded-md border bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                                  value={override?.effect ?? 'inherit'}
                                  disabled={admin || saving}
                                  onChange={(event) => changePermissionOverride(action.key, event.target.value as 'inherit' | PermissionEffect)}
                                >
                                  <option value="inherit">继承模板</option>
                                  <option value="allow">明确允许</option>
                                  <option value="deny">明确拒绝</option>
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <Gauge className="h-5 w-5 text-cyan-600" />
                  <h3 className="font-semibold">用量与配额</h3>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">已用量和预留量都会占用剩余额度；左右滑动查看所有指标。</p>
              </div>
              <span className="text-xs text-muted-foreground">used 已用 · reserved 执行中预留</span>
            </div>

            <div className="platform-nav-scroll -mx-5 mt-4 flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain px-5 pb-3 touch-pan-x sm:-mx-6 sm:px-6 [scrollbar-gutter:stable]">
              {quotaMetrics.map((metric) => {
                const quota = effectiveQuotaByMetric.get(metric);
                const override = quotaOverrides[metric];
                const percent = quota ? quotaPercent(quota) : 0;
                const structuralMetric = [
                  'projects.owned',
                  'agent.pending',
                  'agent.concurrent',
                ].includes(metric);
                const postpaidMetric = [
                  'llm.total_tokens.monthly',
                  'quant.data_units.daily',
                ].includes(metric);
                return (
                  <article key={metric} className="w-[min(86vw,23rem)] shrink-0 snap-start rounded-2xl border bg-background p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="font-semibold">{metricLabel(metric)}</h4>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{metric}</p>
                      </div>
                      {quota?.unlimited ? (
                        <span className="flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-1 text-xs text-violet-700 dark:text-violet-300"><InfinityIcon className="h-3.5 w-3.5" />不限额</span>
                      ) : quota?.exceeded ? (
                        <span className="rounded-full bg-red-500/10 px-2 py-1 text-xs text-red-600">已超额</span>
                      ) : (
                        <span className="rounded-full bg-cyan-500/10 px-2 py-1 text-xs text-cyan-700 dark:text-cyan-300">{WINDOW_LABELS[quota?.windowType ?? 'month']}</span>
                      )}
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-lg bg-muted/45 px-2 py-2"><p className="text-[11px] text-muted-foreground">已用</p><p className="mt-1 truncate text-sm font-semibold" title={quota?.used}>{formatAmount(quota?.used ?? '0')}</p></div>
                      <div className="rounded-lg bg-muted/45 px-2 py-2"><p className="text-[11px] text-muted-foreground">预留</p><p className="mt-1 truncate text-sm font-semibold" title={quota?.reserved}>{formatAmount(quota?.reserved ?? '0')}</p></div>
                      <div className="rounded-lg bg-primary/[0.07] px-2 py-2"><p className="text-[11px] text-muted-foreground">剩余</p><p className="mt-1 truncate text-sm font-semibold text-primary" title={quota?.remaining ?? '不限额'}>{quota?.unlimited ? '∞' : formatAmount(quota?.remaining ?? null)}</p></div>
                    </div>

                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className={`h-full rounded-full ${percent >= 100 ? 'bg-red-500' : percent >= 80 ? 'bg-amber-500' : 'bg-cyan-500'}`} style={{ width: `${percent}%` }} />
                    </div>
                    <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
                      <p className="flex items-center justify-between gap-2"><span>{quota ? sourceLabel(quota.source) : '等待用量数据'}</span><span>{quota ? ENFORCEMENT_LABELS[quota.enforcement] : '—'}</span></p>
                      <p className="flex items-center justify-between gap-2"><span>额度上限：{quota?.unlimited ? '∞' : formatAmount(quota?.limit ?? null)}</span><span className="truncate">重置：{quota ? resetLabel(quota) : '—'}</span></p>
                    </div>

                    {!admin ? (
                      <div className="mt-4 border-t pt-4">
                        <Button type="button" size="sm" variant={override ? 'secondary' : 'outline'} className="w-full" disabled={saving} onClick={() => toggleQuotaOverride(metric)}>
                          {override ? '移除单项覆盖' : '添加单项覆盖'}
                        </Button>
                        {override ? (
                          <div className="mt-3 space-y-3 rounded-xl bg-muted/35 p-3">
                            <label className="flex items-center gap-2 text-xs font-medium">
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-primary"
                                checked={override.isUnlimited}
                                onChange={(event) => updateQuotaOverride(metric, { isUnlimited: event.target.checked, limit: event.target.checked ? null : quota?.limit ?? '1' })}
                              />
                              此成员不限额
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label className="text-[11px]" htmlFor={`quota-limit-${metric}`}>上限</Label>
                                <Input
                                  id={`quota-limit-${metric}`}
                                  className="h-8 text-xs"
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  disabled={override.isUnlimited}
                                  value={override.limit ?? ''}
                                  onChange={(event) => updateQuotaOverride(metric, { limit: event.target.value })}
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-[11px]" htmlFor={`quota-window-${metric}`}>统计窗口</Label>
                                <select
                                  id={`quota-window-${metric}`}
                                  className="h-8 w-full cursor-not-allowed rounded-md border bg-muted/40 px-2 text-xs text-muted-foreground"
                                  value={override.windowType}
                                  disabled
                                >
                                  <option value="minute">每分钟</option>
                                  <option value="hour">每小时</option>
                                  <option value="day">每天</option>
                                  <option value="month">每月</option>
                                  <option value="lifetime">永久累计</option>
                                  {override.windowType === 'fixed' ? <option value="fixed" disabled>固定窗口（保留）</option> : null}
                                </select>
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[11px]" htmlFor={`quota-enforcement-${metric}`}>达到阈值时</Label>
                              <select
                                id={`quota-enforcement-${metric}`}
                                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                                value={override.enforcement}
                                disabled={structuralMetric}
                                onChange={(event) => updateQuotaOverride(metric, { enforcement: event.target.value as QuotaEnforcement })}
                              >
                                {!structuralMetric ? <option value="observe">仅观测</option> : null}
                                {!structuralMetric ? <option value="warn">接近时提醒</option> : null}
                                {!postpaidMetric ? <option value="hard">达到后阻止</option> : null}
                              </select>
                              <p className="text-[10px] text-muted-foreground">
                                {structuralMetric
                                  ? '结构性配额固定为硬限制。'
                                  : postpaidMetric
                                    ? '按实际结果结算，暂不支持硬限制。'
                                    : '可按职责选择观测、提醒或硬限制。'}
                              </p>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-dashed bg-muted/25 px-3 py-2 text-center text-xs text-muted-foreground">管理员数值编辑已禁用</div>
                    )}
                  </article>
                );
              })}
              {quotaMetrics.length === 0 ? <p className="py-8 text-sm text-muted-foreground">尚无可展示的配额指标。</p> : null}
            </div>
          </div>

          {!admin ? (
            <div className="sticky bottom-3 z-10 rounded-2xl border bg-background/95 p-4 shadow-xl backdrop-blur">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="min-w-0 flex-1 space-y-2">
                  <Label htmlFor="access-change-reason">变更原因 <span className="text-red-500">*</span></Label>
                  <Input
                    id="access-change-reason"
                    maxLength={500}
                    placeholder="例如：项目组新增策略回测职责（至少 3 个字符）"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                <Button type="button" className="lg:min-w-36" disabled={saving || reason.trim().length < 3} onClick={() => void saveChanges()}>
                  <Save className="h-4 w-4" />
                  {saving ? '正在保存…' : '保存并审计'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : !loadingDetails ? (
        <div className="p-12 text-center text-sm text-muted-foreground">请选择一个用户查看权限与配额。</div>
      ) : null}
    </section>
  );
}
