import Link from 'next/link';
import {
  Activity,
  BarChart3,
  ClipboardList,
  FileText,
  Layers3,
  Loader2,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCompactDate as formatDate } from '@/components/quant/console-primitives';
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
  return (
    <>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={<ClipboardList className="h-4 w-4" />}
          label="全部用例"
          value={dashboard.summary.caseCount}
          helper={`${dashboard.summary.capabilityCount} 个能力域`}
          tone="blue"
        />
        <StatTile
          icon={<ShieldCheck className="h-4 w-4" />}
          label="最新通过率"
          value={<span className={passRateClass(dashboard.summary.latestPassRate)}>{dashboard.summary.latestPassRate}%</span>}
          helper={
            <span className="flex items-center gap-2">
              {dashboard.summary.latestPassedCount}/{dashboard.summary.latestTotal} 通过
              {delta && <DeltaText value={delta.passRate} suffix="%" />}
            </span>
          }
          tone="emerald"
        />
        <StatTile
          icon={<TriangleAlert className="h-4 w-4" />}
          label="失败用例"
          value={<span className={dashboard.summary.latestFailedCount ? 'text-red-600' : 'text-slate-950'}>{dashboard.summary.latestFailedCount}</span>}
          helper={
            <span className="flex items-center gap-2">
              最新运行
              {delta && <DeltaText value={delta.failed} />}
            </span>
          }
          tone={dashboard.summary.latestFailedCount ? 'red' : 'slate'}
        />
        <StatTile
          icon={<Activity className="h-4 w-4" />}
          label="运行队列"
          value={activeQueueCount}
          helper={`${dashboard.queue.length} 条队列记录`}
          tone={activeQueueCount ? 'amber' : 'slate'}
        />
      </section>

      <Panel title="运行配置" icon={<SlidersHorizontal className="h-4 w-4 text-blue-600" />}>
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.25fr)_150px_190px_160px_130px_auto]">
          <ConfigField label="评测集">
            <select className={selectClassName} value={selectedEvalSetId} onChange={(event) => onSelectedEvalSetChange(event.target.value)}>
              {evalSets.map((evalSet) => (
                <option key={evalSet.id} value={evalSet.id}>
                  {evalSet.name}（{evalSet.caseIds.length}）
                </option>
              ))}
            </select>
          </ConfigField>
          <ConfigField label="运行器">
            <select className={selectClassName} value={benchmarkCli} onChange={(event) => onBenchmarkCliChange(event.target.value)}>
              {runtimeOptions.map((runtime) => (
                <option key={runtime.cli} value={runtime.cli}>
                  {runtime.label}
                </option>
              ))}
            </select>
          </ConfigField>
          <ConfigField label="模型">
            <select className={selectClassName} value={benchmarkModel} onChange={(event) => onBenchmarkModelChange(event.target.value)}>
              {benchmarkRuntime.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </ConfigField>
          <ConfigField label="推理强度">
            {benchmarkRuntimeSupportsReasoning ? (
              <select
                className={selectClassName}
                value={benchmarkReasoningEffort}
                onChange={(event) => onBenchmarkReasoningEffortChange(event.target.value)}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            ) : (
              <div className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500">
                不适用
              </div>
            )}
          </ConfigField>
          <ConfigField label="数量限制">
            <select className={selectClassName} value={limit} onChange={(event) => onLimitChange(event.target.value)}>
              <option value="all">不限</option>
              <option value="1">1 个</option>
              <option value="3">3 个</option>
              <option value="6">6 个</option>
            </select>
          </ConfigField>
          <Button className="mt-auto bg-blue-600 text-white hover:bg-blue-700 xl:self-end" onClick={onStart} disabled={isStarting}>
            {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            运行评测集
          </Button>
        </div>
      </Panel>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="最新运行" icon={<BarChart3 className="h-4 w-4 text-emerald-600" />}>
          <div className="p-4">
            {latestRun ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">通过率</p>
                    <p className={`mt-1 text-lg font-semibold ${passRateClass(latestRun.passRate)}`}>{latestRun.passRate}%</p>
                  </div>
                  <div className="rounded-md bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">得分</p>
                    <p className={`mt-1 text-lg font-semibold ${scoreClass(latestRun.averageScore)}`}>{latestRun.averageScore}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">耗时</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">{formatDuration(latestRun.durationMs)}</p>
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-white p-3">
                  <p className="truncate font-mono text-xs text-slate-600">{latestRun.fileName}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatDate(latestRun.createdAt)} · {latestRun.metadata.runtime.cli} / {latestRun.metadata.runtime.model}
                  </p>
                </div>
                <Button variant="outline" className="w-full" asChild>
                  <Link href={`/evals/runs/${latestRun.id}`}>
                    <FileText className="h-4 w-4" />
                    查看详情
                  </Link>
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">暂无评测报告。</p>
            )}
          </div>
        </Panel>

        <Panel title="模型概览" icon={<Layers3 className="h-4 w-4 text-blue-600" />}>
          <div className="divide-y divide-slate-100">
            {dashboard.modelComparison.slice(0, 4).map((item) => (
              <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_64px_64px] items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">
                    {CLI_LABELS[item.cli] ?? item.cli} · {item.model}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{item.runs} 次运行</p>
                </div>
                <span className={`font-semibold ${passRateClass(item.latestPassRate)}`}>{item.latestPassRate}%</span>
                <span className={`font-semibold ${scoreClass(item.averageScore)}`}>{item.averageScore}</span>
              </div>
            ))}
            {!dashboard.modelComparison.length && <div className="p-8 text-center text-sm text-slate-500">暂无模型对比数据。</div>}
          </div>
        </Panel>
      </section>
    </>
  );
}
