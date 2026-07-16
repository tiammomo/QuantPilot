'use client';

import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Database,
  FileText,
  FolderKanban,
  Gauge,
  Infinity as InfinityIcon,
  KeyRound,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

type PermissionScope = 'account' | 'project' | 'platform';
type QuotaWindow = 'minute' | 'hour' | 'day' | 'month' | 'fixed' | 'lifetime';

interface AccountUsageDetails {
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
  permissions: Array<{
    action: string;
    scope: PermissionScope;
    description: string;
    allowed: boolean;
    source: string;
    projectRoleRequired: boolean;
  }>;
  quotas: Array<{
    metric: string;
    source: string;
    unlimited: boolean;
    enforcement: 'observe' | 'warn' | 'hard';
    limit: string | null;
    used: string;
    reserved: string;
    remaining: string | null;
    exceeded: boolean;
    windowType: QuotaWindow;
    windowStart: string;
    windowEnd: string;
  }>;
}

const SCOPE_META: Record<PermissionScope, { label: string; description: string }> = {
  account: { label: '账号能力', description: '研究、策略与数据能力。' },
  project: { label: '项目能力', description: '实际操作时还需要满足项目 owner / editor / viewer 角色要求。' },
  platform: { label: '平台治理', description: '全平台设置、审计和用户治理能力。' },
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
  'agent.concurrent': '智能体并发数',
  'agent.requests.daily': '智能体每日请求',
  'llm.total_tokens.monthly': 'LLM 每月 Token',
  'query_rewrite.llm.daily': 'LLM 查询改写次数',
  'quant.data_units.daily': '量化数据单元',
  'research.report_runs.daily': '研究报告生成次数',
  'research.report_sends.daily': '研究报告发送次数',
};

const METRIC_ICONS: Record<string, LucideIcon> = {
  'projects.owned': FolderKanban,
  'agent.concurrent': Activity,
  'agent.requests.daily': Bot,
  'llm.total_tokens.monthly': Sparkles,
  'query_rewrite.llm.daily': KeyRound,
  'quant.data_units.daily': Database,
  'research.report_runs.daily': FileText,
  'research.report_sends.daily': Send,
};

const WINDOW_LABELS: Record<QuotaWindow, string> = {
  minute: '每分钟',
  hour: '每小时',
  day: '每天',
  month: '每月',
  fixed: '固定窗口',
  lifetime: '永久累计',
};

function formatAmount(value: string | null): string {
  if (value === null) return '∞';
  try {
    return BigInt(value).toLocaleString('zh-CN');
  } catch {
    return value;
  }
}

function quotaPercent(quota: AccountUsageDetails['quotas'][number]): number {
  if (!quota.limit || quota.limit === '0') return 0;
  try {
    const consumed = BigInt(quota.used) + BigInt(quota.reserved);
    const basisPoints = (consumed * 10_000n) / BigInt(quota.limit);
    return Math.min(100, Number(basisPoints) / 100);
  } catch {
    return 0;
  }
}

function hasQuotaActivity(quota: AccountUsageDetails['quotas'][number]): boolean {
  try {
    return BigInt(quota.used) + BigInt(quota.reserved) > 0n;
  } catch {
    return quota.used !== '0' || quota.reserved !== '0';
  }
}

function resetLabel(quota: AccountUsageDetails['quotas'][number]): string {
  if (quota.windowType === 'lifetime') return '不重置';
  const date = new Date(quota.windowEnd);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN');
}

function sourceLabel(source: string): string {
  if (source === 'administrator') return '管理员默认授权';
  if (source === 'not-granted') return '未授权';
  if (source.startsWith('user-override:allow')) return '单项覆盖允许';
  if (source.startsWith('user-override:deny')) return '单项覆盖拒绝';
  if (source.startsWith('profile:')) return '权限模板';
  if (source === 'admin_unlimited') return '管理员不限额';
  if (source === 'user-override' || source === 'user_override') return '单项配额覆盖';
  if (source === 'profile') return '配额模板';
  if (source === 'default_profile') return '默认配额模板';
  if (source === 'builtin-default') return '内置默认配额';
  if (source === 'unconfigured') return '未配置（仅观测）';
  return source.replaceAll('_', ' ');
}

export default function AccountUsageClient() {
  const [details, setDetails] = useState<AccountUsageDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadUsage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/account/usage', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '用量与配额加载失败。');
      setDetails(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '用量与配额加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const groupedPermissions = useMemo(() => (
    (['account', 'project', 'platform'] as const).map((scope) => ({
      scope,
      permissions: details?.permissions.filter((permission) => permission.scope === scope) ?? [],
    }))
  ), [details]);

  const allowedCount = details?.permissions.filter((permission) => permission.allowed).length ?? 0;
  const activeQuotaCount = details?.quotas.filter(hasQuotaActivity).length ?? 0;

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-7xl space-y-10">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Button variant="ghost" size="sm" className="-ml-3 mb-2" asChild>
              <Link href="/"><ArrowLeft className="h-4 w-4" />返回工作台</Link>
            </Button>
            <p className="text-sm font-medium text-primary">账号中心</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">用量与配额</h1>
            <p className="mt-2 text-sm text-muted-foreground">查看当前有效权限、执行中预留和各统计窗口的剩余额度。</p>
          </div>
          <Button variant="ghost" className="rounded-none border-b border-border px-1" disabled={loading} onClick={() => void loadUsage()}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新
          </Button>
        </header>

        {error ? (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
          </div>
        ) : null}

        {loading && !details ? (
          <div className="rounded-2xl border bg-card p-12 text-center text-sm text-muted-foreground shadow-sm">正在汇总权限与用量…</div>
        ) : details ? (
          <>
            <section className="relative overflow-hidden border-y border-border/70 py-7">
              <div className="pointer-events-none absolute left-1/3 top-0 h-40 w-96 rounded-full bg-primary/[0.07] blur-3xl" />
              <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-4">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/[0.07] text-primary"><ShieldCheck className="h-6 w-6" /></span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-xl font-bold">{details.user.name}</h2>
                      <span className="text-xs font-semibold text-primary">{details.user.isAdmin ? '管理员' : '成员'}</span>
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">{details.user.email}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {details.user.isAdmin ? '管理员默认拥有全部平台权限，所有配额均不限额。' : `${details.permissionProfile?.name ?? '自定义权限'} · ${details.quotaProfile?.name ?? '平台默认配额'}`}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 divide-x divide-border border-y border-border/60 lg:border-y-0">
                  <div className="px-4 py-3 lg:px-6"><p className="text-xl font-bold text-primary">{allowedCount}</p><p className="mt-1 text-[11px] text-muted-foreground">可用能力</p></div>
                  <div className="px-4 py-3 lg:px-6"><p className="text-xl font-bold">{activeQuotaCount}</p><p className="mt-1 text-[11px] text-muted-foreground">本期有使用</p></div>
                  <div className="px-4 py-3 lg:px-6"><p className="flex items-center gap-1 text-xl font-bold text-violet-600">{details.user.isAdmin ? <InfinityIcon className="h-5 w-5" /> : details.quotas.length}</p><p className="mt-1 text-[11px] text-muted-foreground">{details.user.isAdmin ? '配额上限' : '配额指标'}</p></div>
                </div>
              </div>
            </section>

            <section>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div><div className="flex items-center gap-2"><Gauge className="h-5 w-5 text-primary" /><h2 className="text-lg font-bold">本期用量</h2></div><p className="mt-1 text-sm text-muted-foreground">按统计周期展示已消耗、执行中预留与剩余额度。</p></div>
                <p className="text-xs text-muted-foreground">{details.user.isAdmin ? '管理员账号仅记录用量，不限制使用。' : '达到预警线时会在这里提示。'}</p>
              </div>

              <div className="mt-5 grid gap-x-10 border-y border-border/70 md:grid-cols-2">
                {details.quotas.map((quota) => {
                  const percent = quotaPercent(quota);
                  const MetricIcon = METRIC_ICONS[quota.metric] ?? Gauge;
                  return (
                    <article key={quota.metric} className="flex min-w-0 gap-4 border-b border-border/60 py-5 md:[&:nth-last-child(-n+2)]:border-b-0">
                      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center text-primary"><MetricIcon className="h-5 w-5" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0"><h3 className="truncate text-sm font-bold">{METRIC_LABELS[quota.metric] ?? quota.metric}</h3><p className="mt-1 text-[11px] text-muted-foreground">{WINDOW_LABELS[quota.windowType]} · {sourceLabel(quota.source)}</p></div>
                          <div className="shrink-0 text-right"><p className="text-lg font-bold" title={quota.used}>{formatAmount(quota.used)}</p><p className="text-[10px] text-muted-foreground">已使用</p></div>
                        </div>

                        {quota.unlimited ? (
                          <div className="mt-3 h-1 overflow-hidden bg-muted"><div className="h-full w-full bg-gradient-to-r from-violet-500/70 via-primary/35 to-transparent" /></div>
                        ) : (
                          <div className="mt-3 h-1 overflow-hidden bg-muted"><div className={`${percent >= 100 ? 'bg-red-500' : percent >= 80 ? 'bg-amber-500' : 'bg-primary'} h-full`} style={{ width: `${percent}%` }} /></div>
                        )}

                        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                          <span>{quota.unlimited ? '不限额' : `剩余 ${formatAmount(quota.remaining)} / ${formatAmount(quota.limit)}`}</span>
                          {quota.reserved !== '0' ? <span className="font-semibold text-amber-600">执行中预留 {formatAmount(quota.reserved)}</span> : null}
                          <span>{quota.windowType === 'lifetime' ? '不重置' : `重置于 ${resetLabel(quota)}`}</span>
                        </div>
                      </div>
                    </article>
                  );
                })}
                {details.quotas.length === 0 ? <p className="py-8 text-sm text-muted-foreground">暂时没有用量指标。</p> : null}
              </div>
            </section>

            <section>
              <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><h2 className="text-lg font-bold">能力范围</h2></div>
              <p className="mt-1 text-sm text-muted-foreground">展示当前账号可以使用的能力；将鼠标停留在能力名称上可查看技术权限标识。</p>

              <div className="mt-5 border-y border-border/70">
                {groupedPermissions.map(({ scope, permissions }) => {
                  const scopeAllowedCount = permissions.filter((permission) => permission.allowed).length;
                  return (
                    <div key={scope} className="grid gap-4 border-b border-border/60 py-6 last:border-b-0 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
                      <div>
                        <div className="flex items-baseline justify-between gap-3 lg:block">
                          <h3 className="text-sm font-bold">{SCOPE_META[scope].label}</h3>
                          <span className="text-[11px] font-semibold text-primary lg:mt-1 lg:block">{scopeAllowedCount} / {permissions.length} 可用</span>
                        </div>
                        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{SCOPE_META[scope].description}</p>
                      </div>

                      <div className="flex flex-wrap content-start gap-x-6 gap-y-3">
                        {permissions.map((permission) => (
                          <span
                            key={permission.action}
                            title={`${permission.action} · ${sourceLabel(permission.source)}`}
                            className={`inline-flex items-center gap-1.5 text-sm ${permission.allowed ? 'font-medium text-foreground' : 'text-muted-foreground/65'}`}
                          >
                            {permission.allowed ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
                            {ACTION_LABELS[permission.action] ?? permission.action}
                            {permission.projectRoleRequired ? <span className="text-[9px] text-muted-foreground">需项目角色</span> : null}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
