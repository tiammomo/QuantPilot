import {
  Activity,
  BarChart3,
  ClipboardList,
  Clock,
  Loader2,
  Play,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CLI_LABELS,
  ConfigField,
  DeltaText,
  Panel,
  StatTile,
  formatDuration,
  passRateClass,
  scoreClass,
  selectClassName,
  type EvalSet,
} from '@/components/quant/eval-console-primitives';
import type { QuantEvalDashboardData, QuantEvalRun, QuantEvalRuntimeOption } from '@/lib/quant/evals';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';

type RunDelta = {
  passRate: number;
  score: number;
  failed: number;
} | null;

type EvalOverviewViewProps = {
  dashboard: QuantEvalDashboardData;
  latestRun: QuantEvalRun | null;
  delta: RunDelta;
  activeQueueCount: number;
  evalSets: EvalSet[];
  selectedEvalSetId: string;
  limit: string;
  runtimeOptions: QuantEvalRuntimeOption[];
  benchmarkCli: string;
  benchmarkModel: string;
  benchmarkReasoningEffort: string;
  benchmarkRuntime: QuantEvalRuntimeOption;
  benchmarkRuntimeSupportsReasoning: boolean;
  isStarting: boolean;
  onSelectedEvalSetChange: (evalSetId: string) => void;
  onBenchmarkCliChange: (cli: string) => void;
  onBenchmarkModelChange: (model: string) => void;
  onBenchmarkReasoningEffortChange: (effort: string) => void;
  onLimitChange: (limit: string) => void;
  onStart: () => void;
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
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(217,20%,18%)" vertical={false} />
        <XAxis dataKey="range" tick={{ fill: 'hsl(217,15%,55%)', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: 'hsl(217,15%,55%)', fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={{ backgroundColor: 'hsl(222,25%,10%)', border: '1px solid hsl(217,20%,18%)', borderRadius: 8, color: 'hsl(210,40%,95%)', fontSize: 12 }}
          cursor={{ fill: 'hsl(217,25%,15%)' }}
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
  const chartData = [...runs].reverse().slice(-20).map((run, i) => ({
    name: `第 ${i + 1} 次`,
    passRate: run.passRate,
    score: run.averageScore,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(217,20%,18%)" vertical={false} />
        <XAxis dataKey="name" tick={{ fill: 'hsl(217,15%,55%)', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: 'hsl(217,15%,55%)', fontSize: 11 }} axisLine={false} tickLine={false} domain={[0, 100]} />
        <Tooltip
          contentStyle={{ backgroundColor: 'hsl(222,25%,10%)', border: '1px solid hsl(217,20%,18%)', borderRadius: 8, color: 'hsl(210,40%,95%)', fontSize: 12 }}
        />
        <Line type="monotone" dataKey="passRate" stroke="hsl(160,60%,45%)" strokeWidth={2} dot={{ r: 3, fill: 'hsl(160,60%,45%)' }} name="通过率 %" />
        <Line type="monotone" dataKey="score" stroke="hsl(217,91%,60%)" strokeWidth={2} dot={{ r: 3, fill: 'hsl(217,91%,60%)' }} name="平均分" />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function EvalOverviewView({
  dashboard,
  latestRun,
  delta,
  activeQueueCount,
  evalSets,
  selectedEvalSetId,
  limit,
  runtimeOptions,
  benchmarkCli,
  benchmarkModel,
  benchmarkReasoningEffort,
  benchmarkRuntime,
  benchmarkRuntimeSupportsReasoning,
  isStarting,
  onSelectedEvalSetChange,
  onBenchmarkCliChange,
  onBenchmarkModelChange,
  onBenchmarkReasoningEffortChange,
  onLimitChange,
  onStart,
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

      {/* Run config */}
      <Panel title="运行配置" icon={<Play className="h-4 w-4 text-primary" />}>
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.25fr)_150px_190px_160px_130px_auto]">
          <ConfigField label="评测集">
            <select className={selectClassName} value={selectedEvalSetId} onChange={(event) => onSelectedEvalSetChange(event.target.value)}>
              {evalSets.map((evalSet) => (
                <option key={evalSet.id} value={evalSet.id}>{evalSet.name} ({evalSet.caseIds.length})</option>
              ))}
            </select>
          </ConfigField>
          <ConfigField label="运行器">
            <select className={selectClassName} value={benchmarkCli} onChange={(event) => onBenchmarkCliChange(event.target.value)}>
              {runtimeOptions.map((runtime) => (
                <option key={runtime.cli} value={runtime.cli}>{runtime.label}</option>
              ))}
            </select>
          </ConfigField>
          <ConfigField label="模型">
            <select className={selectClassName} value={benchmarkModel} onChange={(event) => onBenchmarkModelChange(event.target.value)}>
              {benchmarkRuntime.models.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </ConfigField>
          <ConfigField label="推理强度">
            {benchmarkRuntimeSupportsReasoning ? (
              <select className={selectClassName} value={benchmarkReasoningEffort} onChange={(event) => onBenchmarkReasoningEffortChange(event.target.value)}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            ) : (
              <div className="flex h-9 items-center rounded-lg border border-border/40 bg-muted/30 px-3 text-sm text-muted-foreground">不适用</div>
            )}
          </ConfigField>
          <ConfigField label="数量">
            <select className={selectClassName} value={limit} onChange={(event) => onLimitChange(event.target.value)}>
              <option value="all">不限</option>
              <option value="1">1</option>
              <option value="3">3</option>
              <option value="6">6</option>
            </select>
          </ConfigField>
          <Button className="mt-auto xl:self-end" onClick={onStart} disabled={isStarting}>
            {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            启动评测
          </Button>
        </div>
      </Panel>

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
    </div>
  );
}
