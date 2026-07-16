import {
  Activity,
  ArrowRight,
  BarChart3,
  ClipboardList,
  Cpu,
  Layers3,
  Play,
  ShieldCheck,
  Target,
  TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CLI_LABELS,
  DeltaText,
  Panel,
  StatTile,
  formatDuration,
  passRateClass,
  scoreClass,
  type EvalSet,
  type EvalView,
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
  onNavigate: (view: EvalView) => void;
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
  firstPassRate: number;
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
      firstPassRate: run.qualitySummary.firstPassRate,
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
        <Line type="monotone" dataKey="firstPassRate" stroke="hsl(38,90%,55%)" strokeWidth={2} dot={{ r: 3, fill: 'hsl(38,90%,55%)' }} name="首轮通过率" />
        <Line type="monotone" dataKey="passRate" stroke="hsl(160,60%,45%)" strokeWidth={2} dot={{ r: 3, fill: 'hsl(160,60%,45%)' }} name="最终通过率" />
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
              {item.dataKey === 'passRate' || item.dataKey === 'firstPassRate' ? '%' : ''}
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
  onNavigate,
}: {
  runs: QuantEvalRun[];
  evalSets: EvalSet[];
  onNavigate: (view: EvalView) => void;
}) {
  const recentRows: RecentEvalSetRow[] = runs.slice(0, 8).map((run) => {
    const evalSet = resolveRunEvalSet(run, evalSets);
    const selectedCount = run.metadata.selection.selectedCases.length || run.total;

    return { run, evalSet, selectedCount };
  });

  return (
    <Panel
      title="最近评测运行"
      icon={<ClipboardList className="h-4 w-4 text-primary" />}
      action={(
        <Button variant="ghost" size="sm" onClick={() => onNavigate('queue')} className="h-8 gap-1 text-xs text-muted-foreground">
          全部记录
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      )}
    >
      {recentRows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-semibold text-muted-foreground">
                <th className="px-4 py-3">评测集</th>
                <th className="px-4 py-3">用例数</th>
                <th className="px-4 py-3">通过率</th>
                <th className="px-4 py-3">首轮 / 修复</th>
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
                    <td className="px-4 py-3 tabular-nums">
                      <span className={passRateClass(run.qualitySummary.firstPassRate)}>{run.qualitySummary.firstPassRate}%</span>
                      <span className="mx-1.5 text-muted-foreground">/</span>
                      <span className={run.qualitySummary.repairRate > 0 ? 'text-amber-500' : 'text-muted-foreground'}>{run.qualitySummary.repairRate}%</span>
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
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">暂无最近评测运行。</div>
      )}
    </Panel>
  );
}

function EvalSetCatalog({
  evalSets,
  onNavigate,
}: {
  evalSets: EvalSet[];
  onNavigate: (view: EvalView) => void;
}) {
  return (
    <Panel
      title="已准备的评测集"
      icon={<Layers3 className="h-4 w-4 text-primary" />}
      action={(
        <Button variant="ghost" size="sm" onClick={() => onNavigate('evalSets')} className="h-8 gap-1 text-xs text-muted-foreground">
          管理评测集
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      )}
    >
      <div className="grid gap-px bg-border/40 sm:grid-cols-2 xl:grid-cols-3">
        {evalSets.slice(0, 6).map((evalSet) => (
          <button
            key={evalSet.id}
            type="button"
            onClick={() => onNavigate('evalSets')}
            className="group min-w-0 bg-card px-4 py-4 text-left transition-colors hover:bg-primary/5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground group-hover:text-primary">{evalSet.name}</p>
                <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{evalSet.description}</p>
              </div>
              <Badge variant="secondary" className="h-6 shrink-0 rounded-md px-2 text-[10px]">
                {evalSet.caseIds.length} 条
              </Badge>
            </div>
            <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{evalSet.category}</span>
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
            </div>
          </button>
        ))}
      </div>
    </Panel>
  );
}

function BaselineSetup({
  dashboard,
  onNavigate,
}: {
  dashboard: QuantEvalDashboardData;
  onNavigate: (view: EvalView) => void;
}) {
  const capabilityCounts = new Map<string, number>();
  dashboard.cases.forEach((testCase) => {
    capabilityCounts.set(testCase.capabilityLabel, (capabilityCounts.get(testCase.capabilityLabel) ?? 0) + 1);
  });
  const capabilityRows = Array.from(capabilityCounts.entries()).sort((left, right) => right[1] - left[1]);
  const maxCount = Math.max(1, ...capabilityRows.map(([, count]) => count));

  return (
    <section className="grid gap-5 xl:grid-cols-[1.12fr_0.88fr]">
      <Panel title="建立第一条质量基线" icon={<Target className="h-4 w-4 text-primary" />}>
        <div className="p-5">
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            当前用例与评测集已经就绪。完成一次链路模拟并启动真实评测后，这里会自动展示通过率趋势、分数分布和失败用例。
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              { icon: ClipboardList, index: '01', title: '确认评测范围', text: `${dashboard.summary.caseCount} 条用例已入库`, view: 'cases' as EvalView },
              { icon: Cpu, index: '02', title: '配置评测策略', text: '选择规则或 Agent 评测器', view: 'evaluator' as EvalView },
              { icon: Play, index: '03', title: '模拟并启动', text: '验证链路后建立基线', view: 'evaluator' as EvalView },
            ].map((step) => (
              <button key={step.index} type="button" onClick={() => onNavigate(step.view)} className="group rounded-xl border border-border/60 bg-background/65 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-primary/5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold tracking-[0.16em] text-primary">STEP {step.index}</span>
                  <step.icon className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
                </div>
                <p className="mt-5 text-sm font-semibold text-foreground">{step.title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.text}</p>
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="能力覆盖准备度" icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}>
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">用例资产可用</p>
              <p className="mt-0.5 text-xs text-muted-foreground">覆盖 {capabilityRows.length} 个能力域</p>
            </div>
            <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/10">Ready</Badge>
          </div>
          <div className="space-y-3">
            {capabilityRows.slice(0, 5).map(([label, count]) => (
              <div key={label}>
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <span className="truncate font-medium text-foreground">{label}</span>
                  <span className="tabular-nums text-muted-foreground">{count} 条</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/75" style={{ width: `${Math.max(16, (count / maxCount) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </section>
  );
}

function EvalAssurancePanel({ dashboard }: { dashboard: QuantEvalDashboardData }) {
  const mutation = dashboard.assurance.mutation;
  const datasets = dashboard.assurance.datasets;
  const judge = dashboard.assurance.judge;
  return (
    <Panel
      title="评测可信度"
      icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}
      action={<Badge variant="outline" className="text-[10px]">EVAL OF EVALS</Badge>}
    >
      <div className="grid gap-3 p-4 md:grid-cols-3">
        <div className="rounded-xl border border-border/60 bg-background/60 p-4">
          <p className="text-xs font-semibold text-muted-foreground">Mutation kill rate</p>
          <p className={`mt-2 text-2xl font-bold ${mutation?.killRate === 100 ? 'text-emerald-500' : 'text-amber-500'}`}>
            {mutation ? `${mutation.killRate}%` : '待运行'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {mutation ? `${mutation.killed}/${mutation.total} 缺陷被捕获 · 存活 ${mutation.survived}` : '运行 check:eval-mutations 建立证明'}
          </p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/60 p-4">
          <p className="text-xs font-semibold text-muted-foreground">数据与隐藏集合同</p>
          <p className={`mt-2 text-2xl font-bold ${datasets.productionSnapshotCount === datasets.productionCaseCount ? 'text-emerald-500' : 'text-amber-500'}`}>
            {datasets.productionSnapshotCount}/{datasets.productionCaseCount}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            生产 snapshot · 隐藏集{datasets.hiddenConfigured ? '已注入' : '未注入'} · Shadow {datasets.productionReplayConfigured ? '已接入' : '未接入'}
          </p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/60 p-4">
          <p className="text-xs font-semibold text-muted-foreground">Judge 校准</p>
          <p className={`mt-2 text-2xl font-bold ${judge?.productionCalibration && judge.passed ? 'text-emerald-500' : 'text-amber-500'}`}>
            {judge ? `κ ${judge.cohenKappa}` : '待配置'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {judge
              ? `${judge.productionCalibration ? '人工盲评集' : '管线合同'} · 一致率 ${judge.agreementRate}% · MAE ${judge.scoreMeanAbsoluteError}`
              : '尚无 Judge 校准数据'}
          </p>
        </div>
      </div>
    </Panel>
  );
}

export function EvalOverviewView({
  dashboard,
  delta,
  activeQueueCount,
  evalSets,
  onNavigate,
}: EvalOverviewViewProps) {
  const latestRun = dashboard.latestRun;
  const hasRuns = dashboard.runs.length > 0;
  const score = latestRun?.averageScore ?? 0;
  const scoreProgress = Math.max(0, Math.min(100, score));
  const latestQuality = latestRun?.qualitySummary;

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/90 px-5 py-5 shadow-[0_24px_60px_-42px_hsl(var(--shadow-color)/0.65)] sm:px-6 lg:px-8 lg:py-7">
        <div className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-primary/12 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 right-1/3 h-28 w-48 rounded-full bg-blue-500/5 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <Badge variant="outline" className={hasRuns ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500' : 'border-amber-500/25 bg-amber-500/10 text-amber-500'}>
              <span className={hasRuns ? 'mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500' : 'mr-1.5 h-1.5 w-1.5 rounded-full bg-amber-500'} />
              {hasRuns ? '质量基线已建立' : '等待首次基线评测'}
            </Badge>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              {hasRuns
                ? `最近一次首轮通过率 ${latestQuality?.firstPassRate ?? 0}%，最终通过率 ${latestRun?.passRate ?? 0}%`
                : '从一条可信的质量基线开始'}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {hasRuns
                ? `已完成 ${dashboard.summary.reportCount} 次评测运行，持续跟踪 ${dashboard.summary.caseCount} 条用例在 ${dashboard.summary.capabilityCount} 个能力域中的表现。`
                : `系统已准备 ${dashboard.summary.caseCount} 条测试用例和 ${evalSets.length} 个评测集。先模拟执行链路，再启动首次真实评测。`}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={() => onNavigate('evaluator')} className="gap-2 rounded-lg shadow-sm">
                <Play className="h-4 w-4" />
                {hasRuns ? '发起新评测' : '配置首次评测'}
              </Button>
              <Button variant="outline" onClick={() => onNavigate('cases')} className="gap-2 rounded-lg">
                <ClipboardList className="h-4 w-4" />
                查看用例资产
              </Button>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-4 rounded-2xl border border-border/60 bg-background/60 p-4 backdrop-blur-sm lg:min-w-[300px]">
            <div className="relative flex h-24 w-24 shrink-0 items-center justify-center rounded-full" style={{ background: `conic-gradient(hsl(var(--primary)) ${scoreProgress * 3.6}deg, hsl(var(--muted)) 0deg)` }}>
              <div className="flex h-[78px] w-[78px] flex-col items-center justify-center rounded-full bg-card">
                <span className="text-2xl font-bold tabular-nums text-foreground">{hasRuns ? score : '—'}</span>
                <span className="text-[10px] text-muted-foreground">平均分</span>
              </div>
            </div>
            <div className="min-w-0 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-6"><span className="text-muted-foreground">评测报告</span><strong className="tabular-nums text-foreground">{dashboard.summary.reportCount}</strong></div>
              <div className="flex items-center justify-between gap-6"><span className="text-muted-foreground">运行队列</span><strong className="tabular-nums text-foreground">{activeQueueCount}</strong></div>
              <div className="flex items-center justify-between gap-6"><span className="text-muted-foreground">能力覆盖</span><strong className="tabular-nums text-foreground">{dashboard.summary.capabilityCount}</strong></div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <StatTile
          icon={<Activity className="h-4 w-4" />}
          label="活跃任务"
          value={activeQueueCount}
          helper={activeQueueCount ? '队列正在处理' : '当前无执行任务'}
          tone={activeQueueCount > 0 ? 'amber' : 'slate'}
        />
        <StatTile
          icon={<Target className="h-4 w-4" />}
          label="首轮通过率"
          value={<span className={passRateClass(latestQuality?.firstPassRate ?? 0)}>{latestQuality?.firstPassRate ?? 0}%</span>}
          helper={hasRuns ? `修复率 ${latestQuality?.repairRate ?? 0}%` : '等待首次评测'}
          tone="amber"
        />
        <StatTile
          icon={<ShieldCheck className="h-4 w-4" />}
          label="最终通过率"
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
          icon={<Activity className="h-4 w-4" />}
          label="重复稳定率"
          value={<span className={passRateClass(latestQuality?.stability.passRate ?? 0)}>{latestQuality?.stability.passRate ?? 0}%</span>}
          helper={hasRuns
            ? `${latestQuality?.stability.attemptCount ?? 0} 次物理运行 · ${latestQuality?.stability.flakyCaseIds.length ?? 0} 条波动`
            : '支持 1–5 次隔离运行'}
          tone="emerald"
        />
        <StatTile
          icon={<TrendingUp className="h-4 w-4" />}
          label="平均分"
          value={<span className={scoreClass(dashboard.summary.latestAverageScore)}>{dashboard.summary.latestAverageScore}</span>}
          helper={hasRuns ? (delta ? <DeltaText value={delta.score} /> : '最近一次运行') : '等待首次评测'}
          tone="blue"
        />
      </section>

      <EvalAssurancePanel dashboard={dashboard} />

      {hasRuns ? (
        <>
          <section className="grid gap-5 xl:grid-cols-2">
            <Panel title="质量趋势" icon={<TrendingUp className="h-4 w-4 text-emerald-500" />} action={<Badge variant="outline" className="text-[10px]">最近 20 次</Badge>}>
              <div className="p-4">
              <RunsOverTimeChart runs={dashboard.runs} />
              </div>
            </Panel>
            <Panel title="分数分布" icon={<BarChart3 className="h-4 w-4 text-primary" />} action={<Badge variant="outline" className="text-[10px]">{dashboard.runs.length} 次运行</Badge>}>
              <div className="p-4">
              <ScoreDistributionChart runs={dashboard.runs} />
              </div>
            </Panel>
          </section>
          <RecentEvalSetsPanel runs={dashboard.runs} evalSets={evalSets} onNavigate={onNavigate} />
        </>
      ) : (
        <BaselineSetup dashboard={dashboard} onNavigate={onNavigate} />
      )}

      <EvalSetCatalog evalSets={evalSets} onNavigate={onNavigate} />
    </div>
  );
}
