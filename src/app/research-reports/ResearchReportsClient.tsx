"use client";

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  Bell,
  CheckCircle2,
  Database,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Rss,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  NotificationDeliverySnapshot,
  ResearchAutomationDashboard,
  ResearchEvidenceItem,
  ResearchProviderStatus,
  ResearchReportSnapshot,
  ResearchReportRunSnapshot,
  ResearchWatchlistSnapshot,
} from '@/lib/quant/research-reports';

interface ResearchReportsClientProps {
  initialData: ResearchAutomationDashboard;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

const statusLabel: Record<ResearchProviderStatus | string, string> = {
  available: '可用',
  partial: '部分可用',
  unavailable: '不可用',
  disabled: '未启用',
  completed: '已完成',
  running: '运行中',
  failed: '失败',
  dry_run: '模拟推送',
  queued: '已入队',
  delivered: '已送达',
  skipped: '已跳过',
};

function formatTime(value: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === 'available' || status === 'completed' || status === 'delivered') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300';
  }
  if (status === 'partial' || status === 'dry_run' || status === 'queued') {
    return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300';
  }
  if (status === 'unavailable' || status === 'failed') {
    return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300';
  }
  return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300';
}

function scoreClass(score: number | null) {
  if (score == null) return 'text-slate-500';
  if (score >= 80) return 'text-emerald-600 dark:text-emerald-300';
  if (score >= 65) return 'text-blue-600 dark:text-blue-300';
  return 'text-amber-600 dark:text-amber-300';
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof FileText;
  label: string;
  value: string | number;
  tone: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-3">
        <span className={cn('flex h-10 w-10 items-center justify-center rounded-lg', tone)}>
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <div className="text-2xl font-semibold leading-none text-slate-950 dark:text-white">{value}</div>
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{label}</div>
        </div>
      </div>
    </div>
  );
}

function LatestReport({ report }: { report: ResearchReportSnapshot | null }) {
  if (!report) {
    return (
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center gap-2 text-lg font-semibold text-slate-950 dark:text-white">
          <FileText className="h-5 w-5 text-blue-500" />
          最新日报
        </div>
        <div className="mt-8 rounded-lg border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
          暂无日报，点击右上角生成。
        </div>
      </section>
    );
  }

  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 p-6 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold text-slate-950 dark:text-white">
            <FileText className="h-5 w-5 text-blue-500" />
            {report.title}
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">{report.summary}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className={cn('text-3xl font-semibold', scoreClass(report.score))}>{report.score}</div>
          <Badge variant="outline" className={statusClass(report.riskLevel === 'high' ? 'unavailable' : 'partial')}>
            风险 {report.riskLevel}
          </Badge>
        </div>
      </div>
      <div className="grid gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <pre className="min-w-0 max-w-full max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-5 text-sm leading-7 text-slate-700 dark:bg-slate-900/70 dark:text-slate-200">
          {report.contentMarkdown}
        </pre>
        <div className="space-y-3">
          <div className="text-sm font-medium text-slate-950 dark:text-white">证据状态</div>
          {report.evidence.map((item) => (
            <EvidenceCard key={`${item.source}-${item.capturedAt}`} evidence={item} />
          ))}
        </div>
      </div>
    </section>
  );
}

function EvidenceCard({ evidence }: { evidence: ResearchEvidenceItem }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-900 dark:text-white">{evidence.source}</span>
        <Badge variant="outline" className={statusClass(evidence.status)}>
          {statusLabel[evidence.status] ?? evidence.status}
        </Badge>
      </div>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-500 dark:text-slate-400">{evidence.detail}</p>
    </div>
  );
}

function WatchlistPanel({ watchlists }: { watchlists: ResearchWatchlistSnapshot[] }) {
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2 text-base font-semibold text-slate-950 dark:text-white">
        <Rss className="h-5 w-5 text-blue-500" />
        订阅观察池
      </div>
      <div className="mt-4 space-y-3">
        {watchlists.map((watchlist) => (
          <div key={watchlist.id} className="rounded-lg border border-slate-100 p-4 dark:border-slate-800">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-slate-950 dark:text-white">{watchlist.name}</div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{watchlist.universeId ?? '未绑定股票池'}</div>
              </div>
              <Badge variant="outline" className={statusClass('partial')}>{watchlist.status}</Badge>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {watchlist.symbols.map((symbol) => (
                <span key={symbol} className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
                  {symbol}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProviderMatrix({ data }: { data: ResearchAutomationDashboard }) {
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2 text-base font-semibold text-slate-950 dark:text-white">
        <Database className="h-5 w-5 text-blue-500" />
        数据源矩阵
      </div>
      <div className="mt-4 space-y-3">
        {data.providerMatrix.map((item) => (
          <div key={item.id} className="rounded-lg border border-slate-100 p-4 dark:border-slate-800">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-slate-950 dark:text-white">{item.name}</div>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{item.role}</p>
              </div>
              <Badge variant="outline" className={statusClass(item.status)}>{statusLabel[item.status] ?? item.status}</Badge>
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">{item.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function RunsTable({ runs }: { runs: ResearchReportRunSnapshot[] }) {
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4 text-base font-semibold text-slate-950 dark:border-slate-800 dark:text-white">
        <Activity className="h-5 w-5 text-blue-500" />
        运行历史
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-medium text-slate-500 dark:bg-slate-900/70 dark:text-slate-400">
            <tr>
              <th className="px-5 py-3">状态</th>
              <th className="px-5 py-3">类型</th>
              <th className="px-5 py-3">开始时间</th>
              <th className="px-5 py-3">结束时间</th>
              <th className="px-5 py-3">数据模式</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {runs.map((run) => (
              <tr key={run.id}>
                <td className="px-5 py-3">
                  <Badge variant="outline" className={statusClass(run.status)}>{statusLabel[run.status] ?? run.status}</Badge>
                </td>
                <td className="px-5 py-3 text-slate-700 dark:text-slate-300">{run.runType}</td>
                <td className="px-5 py-3 text-slate-500 dark:text-slate-400">{formatTime(run.startedAt)}</td>
                <td className="px-5 py-3 text-slate-500 dark:text-slate-400">{formatTime(run.finishedAt)}</td>
                <td className="px-5 py-3 text-slate-500 dark:text-slate-400">{run.providerMode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeliveryList({ deliveries }: { deliveries: NotificationDeliverySnapshot[] }) {
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2 text-base font-semibold text-slate-950 dark:text-white">
        <Send className="h-5 w-5 text-blue-500" />
        推送记录
      </div>
      <div className="mt-4 space-y-3">
        {deliveries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 p-5 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
            暂无推送记录。
          </div>
        ) : deliveries.map((delivery) => (
          <div key={delivery.id} className="rounded-lg border border-slate-100 p-4 dark:border-slate-800">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="line-clamp-1 font-medium text-slate-950 dark:text-white">{delivery.title}</div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {delivery.channelType} · {formatTime(delivery.deliveredAt ?? delivery.createdAt)}
                </div>
                {delivery.error && (
                  <div className="mt-2 line-clamp-2 text-xs leading-5 text-rose-600 dark:text-rose-300">
                    {delivery.error}
                  </div>
                )}
              </div>
              <Badge variant="outline" className={statusClass(delivery.status)}>{statusLabel[delivery.status] ?? delivery.status}</Badge>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function ResearchReportsClient({ initialData }: ResearchReportsClientProps) {
  const [data, setData] = useState(initialData);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latestReport = data.latestReports[0] ?? null;
  const latestRun = data.recentRuns[0] ?? null;

  const activeChannelText = useMemo(() => {
    const dryRunCount = data.notificationChannels.filter((channel) => channel.isDryRun).length;
    return dryRunCount > 0 ? `${data.summary.activeChannels} / dry-run` : data.summary.activeChannels;
  }, [data.notificationChannels, data.summary.activeChannels]);

  async function refresh() {
    setIsRefreshing(true);
    setError(null);
    try {
      const response = await fetch('/api/research/reports', { cache: 'no-store' });
      const payload = await response.json() as ApiResponse<ResearchAutomationDashboard>;
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.message || payload.error || '刷新失败');
      }
      setData(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsRefreshing(false);
    }
  }

  async function runDailyReport() {
    setIsRunning(true);
    setError(null);
    try {
      const response = await fetch('/api/research/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-daily-report', dryRun: true }),
      });
      const payload = await response.json() as ApiResponse<ResearchAutomationDashboard>;
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.message || payload.error || '生成日报失败');
      }
      setData(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsRunning(false);
    }
  }

  async function sendLatestReport() {
    setIsSending(true);
    setError(null);
    try {
      const response = await fetch('/api/research/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send-latest-report', dryRun: false }),
      });
      const payload = await response.json() as ApiResponse<ResearchAutomationDashboard>;
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.message || payload.error || '推送失败');
      }
      setData(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-6 px-6 py-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <Link href="/" className="text-sm text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-300">
                QuantPilot
              </Link>
              <span className="text-slate-300 dark:text-slate-700">/</span>
              <h1 className="text-2xl font-semibold tracking-normal text-slate-950 dark:text-white">投研日报</h1>
            </div>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              自选池、证据采样、结构化报告和推送记录。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={refresh} disabled={isRefreshing || isRunning || isSending}>
              {isRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              刷新
            </Button>
            <Button variant="outline" onClick={sendLatestReport} disabled={!latestReport || isSending || isRunning || isRefreshing}>
              {isSending ? <Loader2 className="animate-spin" /> : <Send />}
              推送最新
            </Button>
            <Button onClick={runDailyReport} disabled={isRunning || isRefreshing || isSending} className="bg-blue-600 text-white hover:bg-blue-700">
              {isRunning ? <Loader2 className="animate-spin" /> : <Play />}
              生成日报
            </Button>
          </div>
        </header>

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
            <ShieldAlert className="mt-0.5 h-4 w-4" />
            <span>{error}</span>
          </div>
        )}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={Rss} label="观察池" value={data.summary.watchlists} tone="bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300" />
          <StatCard icon={FileText} label="累计报告" value={data.summary.reports} tone="bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300" />
          <StatCard icon={Bell} label="推送通道" value={activeChannelText} tone="bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-300" />
          <StatCard icon={CheckCircle2} label="最新评分" value={data.summary.latestScore ?? '-'} tone="bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300" />
        </section>

        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <LatestReport report={latestReport} />
          <div className="min-w-0 space-y-6">
            <WatchlistPanel watchlists={data.watchlists} />
            <ProviderMatrix data={data} />
          </div>
        </div>

        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <RunsTable runs={data.recentRuns} />
          <DeliveryList deliveries={data.recentDeliveries} />
        </div>

        {latestRun?.status === 'running' && (
          <div className="fixed bottom-6 right-6 rounded-lg border border-blue-200 bg-white px-4 py-3 text-sm text-blue-700 shadow-lg dark:border-blue-500/30 dark:bg-slate-900 dark:text-blue-200">
            日报正在运行中
          </div>
        )}
      </div>
    </main>
  );
}
