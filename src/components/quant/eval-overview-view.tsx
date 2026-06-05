import {
  Activity,
  BarChart3,
  ClipboardList,
  Clock,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  CLI_LABELS,
  DeltaText,
  Panel,
  StatTile,
  formatDuration,
  passRateClass,
  scoreClass,
  type EvalSet,
} from '@/components/quant/eval-console-primitives';
import type { QuantEvalDashboardData, QuantEvalRun } from '@/lib/eval';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';

type RunDelta = {
  passRate: number;
  score: number;
  failed: number;
} | null;

const chartGridColor = 'hsl(var(--border))';
const chartTickColor = 'hsl(var(--muted-foreground))';
const chartTooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  color: 'hsl(var(--foreground))',
  fontSize: 12,
};
const chartCursor = { fill: 'hsl(var(--muted))' };

type EvalOverviewViewProps = {
  dashboard: QuantEvalDashboardData;
  delta: RunDelta;
  activeQueueCount: number;
  evalSets: EvalSet[];
};

type RecentEvalSetRow = {
  run: QuantEvalRun;
  evalSet: EvalSet | null;
  selectedCount: number;
};

type RunTrendPoint = {
  axisLabel: string;
  fullTime: string;
  runIndex: number;
  passRate: number;
  score: number;
};

type RunTrendTooltipPayload = {
  dataKey?: string | number;
  name?: string | number;
  value?: string | number;
  payload?: RunTrendPoint;
};

function ScoreDistributionChart({ runs }: { runs: QuantEvalRun[] }) {
  const buckets = [
    { range: '0-20', min: 0, max: 20, count: 0 },
    { range: '20-40', min: 20, max: 40, count: 0 },
    { range: '40-60', min: 40, max: 60, count: 0 },
    { range: '60-80', min: 60, max: 80, count: 0 },
    { range: '80-100', min: 80, max: 100, count: 0 },
  ];
  for (const run of runs) {
    const score = run.averageScore;
    for (const bucket of buckets) {
      if (score >= bucket.min && score < bucket.max + (bucket.max === 100 ? 1 : 0)) {
        bucket.count++;
        break;
      }
    }
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={buckets} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} vertical={false} />
        <XAxis dataKey="range" tick={{ fill: chartTickColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: chartTickColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={chartTooltipStyle}
          cursor={chartCursor}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {buckets.map((_, index) => (
            <Cell key={index} fill={index < 2 ? 'hsl(0,60%,50%)' : index < 3 ? 'hsl(38,90%,55%)' : 'hsl(160,60%,45%)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function RunsOverTimeChart({ runs }: { runs: QuantEvalRun[] }) {
  const chronologicalRuns = [...runs].reverse();
  const recentRuns = chronologicalRuns.slice(-20);
  const runIndexOffset = chronologicalRuns.length - recentRuns.length;
  const dayCounts = new Map<string, number>();
  recentRuns.forEach((run) => {
    const date = new Date(run.createdAt);
    if (!Number.isNaN(date.getTime())) {
      const dayKey = date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
      dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);
    }
  });

  const chartData: RunTrendPoint[] = recentRuns.map((run, i) => {
    const date = new Date(run.createdAt);
    const isValidDate = !Number.isNaN(date.getTime());
    const dayLabel = isValidDate ? date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '-';
    const timeLabel = isValidDate ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '-';

    return {
      axisLabel: isValidDate && (dayCounts.get(dayLabel) ?? 0) > 1 ? timeLabel : dayLabel,
      fullTime: isValidDate ? date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-',
      runIndex: runIndexOffset + i + 1,
      passRate: run.passRate,
      score: run.averageScore,
    };
  });

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} vertical={false} />
        <XAxis dataKey="axisLabel" tick={{ fill: chartTickColor, fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fill: chartTickColor, fontSize: 11 }} axisLine={false} tickLine={false} domain={[0, 100]} />
        <Tooltip
          contentStyle={chartTooltipStyle}
          content={<RunTrendTooltip />}
        />
        <Line type="monotone" dataKey="passRate" stroke="hsl(160,60%,45%)" strokeWidth={2} dot={{ r: 3, fill: 'hsl(160,60%,45%)' }} name="通过率" />
        <Line type="monotone" dataKey="score" stroke="hsl(217,91%,60%)" strokeWidth={2} dot={{ r: 3, fill: 'hsl(217,91%,60%)' }} name="平均分" />
      </LineChart>
    </ResponsiveContainer>
  );
}

function RunTrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: RunTrendTooltipPayload[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as RunTrendPoint | undefined;
  if (!point) return null;

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg shadow-black/10">
      <div className="font-semibold text-foreground">{point.fullTime}</div>
      <div className="mt-0.5 text-muted-foreground">第 {point.runIndex} 次运行</div>
      <div className="mt-2 space-y-1">
        {payload.map((item) => (
          <div key={String(item.dataKey)} className="flex items-center justify-between gap-5">
            <span className="text-muted-foreground">{item.name}</span>
            <span className="font-semibold tabular-nums text-foreground">
              {item.value}
              {item.dataKey === 'passRate' ? '%' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatRelativeTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function isSameCaseSet(selectedCaseIds: string[], evalSetCaseIds: string[]) {
  if (selectedCaseIds.length !== evalSetCaseIds.length) return false;
  const expectedCaseIds = new Set(evalSetCaseIds);
  return selectedCaseIds.every((caseId) => expectedCaseIds.has(caseId));
}

function resolveRunEvalSet(run: QuantEvalRun, evalSets: EvalSet[]) {
  const selectedCaseIds = run.metadata.selection.selectedCases;
  if (selectedCaseIds.length === 0) {
    return evalSets.find((evalSet) => evalSet.id === 'all') ?? null;
  }

  return evalSets.find((evalSet) => isSameCaseSet(selectedCaseIds, evalSet.caseIds)) ?? null;
}

function RecentEvalSetsPanel({
  runs,
  evalSets,
}: {
  runs: QuantEvalRun[];
  evalSets: EvalSet[];
}) {
  const recentRows: RecentEvalSetRow[] = runs.slice(0, 8).map((run) => {
    const evalSet = resolveRunEvalSet(run, evalSets);
    const selectedCount = run.metadata.selection.selectedCases.length || run.total;

    return { run, evalSet, selectedCount };
  });

  return (
    <Panel title="最近评测集" icon={<ClipboardList className="h-4 w-4 text-primary" />}>
      {recentRows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-semibold text-muted-foreground">
                <th className="px-4 py-3">评测集</th>
                <th className="px-4 py-3">用例数</th>
                <th className="px-4 py-3">通过率</th>
                <th className="px-4 py-3">平均分</th>
                <th className="px-4 py-3">运行器 / 模型</th>
                <th className="px-4 py-3">耗时</th>
                <th className="px-4 py-3">最近运行</th>
                <th className="px-4 py-3 text-right">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {recentRows.map(({ run, evalSet, selectedCount }) => {
                const runtimeCli = run.metadata.runtime.cli ?? 'unknown';
                const runtimeModel = run.metadata.runtime.model ?? '-';
                const displayName = evalSet?.name ?? `自定义 ${selectedCount} 个用例`;

                return (
                  <tr key={run.id} className="transition-colors hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="min-w-0">
                        <div className="max-w-[260px] truncate font-semibold text-foreground">{displayName}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{evalSet?.category ?? '临时选择'}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{selectedCount}</td>
                    <td className={passRateClass(run.passRate) + ' px-4 py-3 font-semibold tabular-nums'}>
                      {run.passRate}%
                    </td>
                    <td className={scoreClass(run.averageScore) + ' px-4 py-3 font-semibold tabular-nums'}>
                      {run.averageScore}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{CLI_LABELS[runtimeCli] ?? runtimeCli}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{runtimeModel}</div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{formatDuration(run.durationMs)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatRelativeTime(run.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Badge className={run.passed ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/10' : 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/10'}>
                        {run.passed ? '通过' : '失败'}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">暂无最近评测集。</div>
      )}
    </Panel>
  );
}

export function EvalOverviewView({
  dashboard,
  delta,
  activeQueueCount,
  evalSets,
}: EvalOverviewViewProps) {
  const queueDepth = dashboard.queue.filter((q) => q.status === 'queued').length;

  return (
    <div className="space-y-5">
      {/* Stat cards */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          icon={<Activity className="h-4 w-4" />}
          label="运行中"
          value={activeQueueCount}
          helper="当前正在运行"
          tone={activeQueueCount > 0 ? 'amber' : 'slate'}
        />
        <StatTile
          icon={<ShieldCheck className="h-4 w-4" />}
          label="通过率"
          value={<span className={passRateClass(dashboard.summary.latestPassRate)}>{dashboard.summary.latestPassRate}%</span>}
          helper={
            <span className="flex items-center gap-2">
              {dashboard.summary.latestPassedCount}/{dashboard.summary.latestTotal}
              {delta && <DeltaText value={delta.passRate} suffix="%" />}
            </span>
          }
          tone="emerald"
        />
        <StatTile
          icon={<TrendingUp className="h-4 w-4" />}
          label="平均分"
          value={<span className={scoreClass(dashboard.summary.latestAverageScore)}>{dashboard.summary.latestAverageScore}</span>}
          helper={delta ? <DeltaText value={delta.score} /> : '最近一次'}
          tone="blue"
        />
        <StatTile
          icon={<ClipboardList className="h-4 w-4" />}
          label="测试用例"
          value={dashboard.summary.caseCount}
          helper="覆盖用例数"
          tone="slate"
        />
        <StatTile
          icon={<Clock className="h-4 w-4" />}
          label="等待队列"
          value={queueDepth}
          helper="等待运行"
          tone={queueDepth > 0 ? 'blue' : 'slate'}
        />
      </section>

      {/* Charts */}
      <section className="grid gap-5 xl:grid-cols-2">
        <Panel title="运行趋势" icon={<TrendingUp className="h-4 w-4 text-emerald-400" />}>
          <div className="p-4">
            {dashboard.runs.length > 0 ? (
              <RunsOverTimeChart runs={dashboard.runs} />
            ) : (
              <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">暂无运行数据。</div>
            )}
          </div>
        </Panel>
        <Panel title="分数分布" icon={<BarChart3 className="h-4 w-4 text-primary" />}>
          <div className="p-4">
            {dashboard.runs.length > 0 ? (
              <ScoreDistributionChart runs={dashboard.runs} />
            ) : (
              <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">暂无运行数据。</div>
            )}
          </div>
        </Panel>
      </section>

      <RecentEvalSetsPanel runs={dashboard.runs} evalSets={evalSets} />
    </div>
  );
}
