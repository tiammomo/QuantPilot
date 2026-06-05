import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Activity,
  CheckCircle2,
  Circle,
  Eye,
  FileText,
  Loader2,
  PauseCircle,
  Play,
  RefreshCcw,
  Search,
  Square,
  SquareStop,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCompactDate as formatDate } from '@/components/quant/console-primitives';
import { getEvalEvaluatorOption } from '@/components/quant/eval-evaluator-view';
import { EvalPagination, formatDuration } from '@/components/quant/eval-console-primitives';
import type { EvalSet } from '@/components/quant/eval-console-primitives';
import type { QuantEvalQueueItem, QuantEvalRun } from '@/lib/quant/evals';
import { cn } from '@/lib/utils';

type QueueStatusFilter = 'all' | 'active' | 'completed' | 'cancelled';

type EvalQueueViewProps = {
  queue: QuantEvalQueueItem[];
  runs: QuantEvalRun[];
  evalSets: EvalSet[];
  totalCaseCount: number;
  onCancelBenchmark: (queueId: string) => void;
  onRefresh: () => Promise<void> | void;
};

function MetricCard({
  icon,
  label,
  value,
  tone = 'blue',
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone?: 'blue' | 'emerald' | 'amber' | 'slate';
}) {
  const toneClass = {
    blue: 'bg-blue-500/10 text-blue-500',
    emerald: 'bg-emerald-500/10 text-emerald-500',
    amber: 'bg-amber-500/10 text-amber-500',
    slate: 'bg-slate-500/10 text-slate-500',
  }[tone];

  return (
    <div className="rounded-lg border border-border/50 bg-card px-5 py-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', toneClass)}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold tabular-nums text-foreground">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  );
}

function statusBadge(status: QuantEvalQueueItem['status']) {
  const config: Record<QuantEvalQueueItem['status'], { label: string; className: string; icon: ReactNode }> = {
    queued: {
      label: '排队中',
      className: 'border-blue-500/30 bg-blue-500/10 text-blue-500',
      icon: <Circle className="h-3 w-3" />,
    },
    running: {
      label: '运行中',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
    },
    passed: {
      label: '已完成',
      className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    failed: {
      label: '已失败',
      className: 'border-red-500/30 bg-red-500/10 text-red-500',
      icon: <SquareStop className="h-3 w-3" />,
    },
    cancelled: {
      label: '已终止',
      className: 'border-slate-500/30 bg-slate-500/10 text-slate-500',
      icon: <Square className="h-3 w-3" />,
    },
  };
  const item = config[status];
  return (
    <Badge className={cn('inline-flex whitespace-nowrap hover:bg-inherit', item.className)}>
      {item.icon}
      <span className="ml-1">{item.label}</span>
    </Badge>
  );
}

function statusMatches(item: QuantEvalQueueItem, filter: QueueStatusFilter) {
  if (filter === 'all') return true;
  if (filter === 'active') return item.status === 'queued' || item.status === 'running';
  if (filter === 'completed') return item.status === 'passed' || item.status === 'failed';
  return item.status === 'cancelled';
}

function isToday(value: string | null) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.toDateString() === new Date().toDateString();
}

function elapsedMs(item: QuantEvalQueueItem) {
  const start = item.startedAt ?? item.createdAt;
  const startMs = new Date(start).getTime();
  if (Number.isNaN(startMs)) return 0;
  const endMs = item.finishedAt ? new Date(item.finishedAt).getTime() : Date.now();
  if (Number.isNaN(endMs) || endMs < startMs) return 0;
  return endMs - startMs;
}

function selectedCaseTarget(item: QuantEvalQueueItem, totalCaseCount: number) {
  if (item.selectedCases.length) return item.selectedCases.length;
  if (item.limit) return item.limit;
  return totalCaseCount;
}

function itemType(item: QuantEvalQueueItem) {
  if (item.selectedCases.length === 1) return '单用例执行';
  if (item.selectedCases.length > 1) return '自定义执行';
  return '评测集执行';
}

function sameCaseSet(left: string[], right: string[]) {
  if (!left.length || left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((caseId) => rightSet.has(caseId));
}

function associatedEvalSet(item: QuantEvalQueueItem, evalSets: EvalSet[]) {
  if (!item.selectedCases.length) return evalSets.find((evalSet) => evalSet.id === 'all')?.name ?? '全部用例';
  const matched = evalSets.find((evalSet) => evalSet.id !== 'all' && sameCaseSet(item.selectedCases, evalSet.caseIds));
  if (matched) return matched.name;
  if (item.selectedCases.length === 1) return item.selectedCases[0];
  return `自定义 ${item.selectedCases.length} 个用例`;
}

function passRateClass(rate: number | null) {
  if (rate === null) return 'text-muted-foreground';
  if (rate >= 80) return 'text-emerald-500';
  if (rate >= 50) return 'text-amber-500';
  return 'text-red-500';
}

function progressTone(item: QuantEvalQueueItem, run?: QuantEvalRun) {
  if (item.status === 'running' || item.status === 'queued') return 'bg-blue-500';
  if (item.status === 'cancelled') return 'bg-slate-400';
  if (run && run.passRate >= 80) return 'bg-emerald-500';
  if (run && run.passRate >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

export function EvalQueueView({
  queue,
  runs,
  evalSets,
  totalCaseCount,
  onCancelBenchmark,
  onRefresh,
}: EvalQueueViewProps) {
  const [keyword, setKeyword] = useState('');
  const [todayOnly, setTodayOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<QueueStatusFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const activeCount = queue.filter((item) => item.status === 'queued' || item.status === 'running').length;
  const completedCount = queue.filter((item) => item.status === 'passed' || item.status === 'failed').length;
  const cancelledCount = queue.filter((item) => item.status === 'cancelled').length;

  const runRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void runRefresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, runRefresh]);

  const filteredQueue = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return queue.filter((item) => {
      if (todayOnly && !isToday(item.startedAt ?? item.createdAt)) return false;
      if (!statusMatches(item, statusFilter)) return false;
      if (!normalizedKeyword) return true;
      const haystack = [
        item.id,
        itemType(item),
        item.status,
        getEvalEvaluatorOption(item.evaluatorId).name,
        `并发 ${item.concurrency}`,
        associatedEvalSet(item, evalSets),
        ...item.selectedCases,
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedKeyword);
    });
  }, [evalSets, keyword, queue, statusFilter, todayOnly]);

  const pageCount = Math.max(1, Math.ceil(filteredQueue.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedQueue = filteredQueue.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [keyword, todayOnly, statusFilter]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const statusOptions: Array<{ id: QueueStatusFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'active', label: '运行中' },
    { id: 'completed', label: '已完成' },
    { id: 'cancelled', label: '已终止' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-xl font-bold tracking-normal text-foreground">运行历史</h2>
          <Badge variant="secondary" className="h-6 rounded-md px-2 text-xs">
            共 {queue.length} 个
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-border bg-background"
            />
            自动刷新
          </label>
          <Button size="sm" onClick={() => void runRefresh()} disabled={isRefreshing} className="h-9 gap-1.5 rounded-lg text-xs">
            <RefreshCcw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
            刷新
          </Button>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard icon={<FileText className="h-4 w-4" />} label="总计" value={queue.length} />
        <MetricCard icon={<Activity className="h-4 w-4" />} label="执行中" value={activeCount} />
        <MetricCard icon={<CheckCircle2 className="h-4 w-4" />} label="已完成" value={completedCount} tone="emerald" />
        <MetricCard icon={<PauseCircle className="h-4 w-4" />} label="已暂停" value={0} tone="amber" />
        <MetricCard icon={<Square className="h-4 w-4" />} label="已终止" value={cancelledCount} tone="slate" />
      </section>

      <section className="rounded-lg border border-border/50 bg-card shadow-sm">
        <div className="border-b border-slate-200/70 p-4 dark:border-border/40">
          <div className="rounded-2xl border border-slate-200/80 bg-background/80 p-3 shadow-sm dark:border-border/40 dark:bg-card/70">
            <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
              <div className="relative min-w-0 lg:w-[340px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索执行记录ID或评测集名称..."
                  className="h-11 rounded-xl border-slate-200/80 bg-card/70 pl-9 text-sm shadow-none dark:border-border/50 dark:bg-background"
                />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTodayOnly((value) => !value)}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors',
                    todayOnly
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-slate-200/80 bg-background text-muted-foreground hover:border-primary/25 hover:bg-primary/5 hover:text-primary dark:border-border/50',
                  )}
                >
                  今天
                </button>
                {statusOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setStatusFilter(option.id)}
                    className={cn(
                      'inline-flex h-9 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors',
                      statusFilter === option.id
                        ? 'border-primary/40 bg-primary text-primary-foreground shadow-sm'
                        : 'border-slate-200/80 bg-background text-muted-foreground hover:border-primary/25 hover:bg-primary/5 hover:text-primary dark:border-border/50',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px] text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-3">执行 ID</th>
                <th className="px-4 py-3">执行类型</th>
                <th className="px-4 py-3">执行状态</th>
                <th className="px-4 py-3 text-center">进度</th>
                <th className="px-4 py-3">通过率</th>
                <th className="px-4 py-3">耗时</th>
                <th className="px-4 py-3">评测器</th>
                <th className="px-4 py-3">关联评测集</th>
                <th className="px-4 py-3">开始时间</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedQueue.map((item) => {
                const run = item.reportId ? runById.get(item.reportId) : undefined;
                const target = run?.total ?? selectedCaseTarget(item, totalCaseCount);
                const completed = run?.total ?? (item.status === 'passed' || item.status === 'failed' ? target : 0);
                const progressPercent = target > 0 ? Math.min(100, Math.round((completed / target) * 100)) : 0;
                const passRate = run ? run.passRate : null;
                const evalSetName = associatedEvalSet(item, evalSets);
                const evaluator = getEvalEvaluatorOption(item.evaluatorId);
                const canCancel = item.status === 'running' || item.status === 'queued';

                return (
                  <tr key={item.id} className="border-b border-border/30 transition-colors last:border-b-0 hover:bg-muted/25">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs font-semibold text-primary">#{item.id.replace(/^eval-run-/, '').slice(0, 8)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="border-blue-500/20 bg-blue-500/5 text-primary">
                        {itemType(item)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{statusBadge(item.status)}</td>
                    <td className="px-4 py-3">
                      <div className="mx-auto w-[120px] space-y-1.5">
                        <div className="text-center font-mono text-xs text-foreground">
                          {completed} / {target}
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className={cn('h-full rounded-full', progressTone(item, run))} style={{ width: `${progressPercent}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className={cn('px-4 py-3 font-mono text-xs font-semibold', passRateClass(passRate))}>
                      {passRate === null ? '-' : `${passRate.toFixed(1)}%`}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground">
                      {formatDuration(run?.durationMs && run.durationMs > 0 ? run.durationMs : elapsedMs(item))}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs font-medium text-foreground">{evaluator.name}</div>
                      <div className="mt-0.5 max-w-[150px] truncate text-[11px] text-muted-foreground">并发上限 {item.concurrency}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-[280px] items-center gap-1.5 text-primary">
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        <span className="max-w-[220px] truncate text-xs font-medium">{evalSetName}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground">{formatDate(item.startedAt ?? item.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {canCancel && (
                          <Button variant="ghost" size="icon" onClick={() => onCancelBenchmark(item.id)} className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label="终止运行">
                            <Square className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {item.reportId && (
                          <Button variant="ghost" size="icon" asChild className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label="查看报告">
                            <Link href={`/eval-platform/runs/${item.reportId}`}>
                              <Eye className="h-3.5 w-3.5" />
                            </Link>
                          </Button>
                        )}
                        {!canCancel && !item.reportId && (
                          <Button variant="ghost" size="icon" disabled className="h-8 w-8 text-muted-foreground" aria-label="暂无操作">
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!pagedQueue.length && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    暂无匹配的运行历史。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <EvalPagination
          page={currentPage}
          pageSize={pageSize}
          totalItems={filteredQueue.length}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize);
            setPage(1);
          }}
        />
      </section>
    </div>
  );
}
