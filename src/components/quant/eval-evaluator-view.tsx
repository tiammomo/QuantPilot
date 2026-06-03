import { Cpu, FileText, Loader2, Play, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ConfigField,
  Panel,
  flowStepClass,
  selectClassName,
  type EvalSet,
} from '@/components/quant/eval-console-primitives';
import type { QuantEvalFlowSimulation, QuantEvalRuntimeOption } from '@/lib/quant/evals';

type EvalEvaluatorViewProps = {
  runtimeOptions: QuantEvalRuntimeOption[];
  benchmarkCli: string;
  benchmarkModel: string;
  benchmarkReasoningEffort: string;
  benchmarkRuntime: QuantEvalRuntimeOption;
  benchmarkRuntimeSupportsReasoning: boolean;
  evalSets: EvalSet[];
  selectedEvalSetId: string;
  selectedEvalSet: EvalSet;
  flowSimulation: QuantEvalFlowSimulation | null;
  isSimulatingFlow: boolean;
  isStarting: boolean;
  onBenchmarkCliChange: (cli: string) => void;
  onBenchmarkModelChange: (model: string) => void;
  onBenchmarkReasoningEffortChange: (effort: string) => void;
  onEvalSetSelect: (evalSetId: string) => void;
  onSimulateFlow: () => void;
  onStart: () => void;
};

export function EvalEvaluatorView({
  runtimeOptions,
  benchmarkCli,
  benchmarkModel,
  benchmarkReasoningEffort,
  benchmarkRuntime,
  benchmarkRuntimeSupportsReasoning,
  evalSets,
  selectedEvalSetId,
  selectedEvalSet,
  flowSimulation,
  isSimulatingFlow,
  isStarting,
  onBenchmarkCliChange,
  onBenchmarkModelChange,
  onBenchmarkReasoningEffortChange,
  onEvalSetSelect,
  onSimulateFlow,
  onStart,
}: EvalEvaluatorViewProps) {
  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Panel
        title="评测器链路"
        icon={<Cpu className="h-4 w-4 text-primary" />}
        action={
          <Button variant="outline" size="sm" onClick={onSimulateFlow} disabled={isSimulatingFlow}>
            {isSimulatingFlow ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            模拟链路
          </Button>
        }
      >
        <div className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
            <ConfigField label="评测范围">
              <select className={selectClassName} value={selectedEvalSetId} onChange={(event) => onEvalSetSelect(event.target.value)}>
                {evalSets.map((evalSet) => (
                  <option key={evalSet.id} value={evalSet.id}>
                    {evalSet.name}（{evalSet.caseIds.length}）
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
                <div className="flex h-9 items-center rounded-lg border border-border bg-muted/50 px-3 text-sm text-muted-foreground">
                  不适用
                </div>
              )}
            </ConfigField>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {runtimeOptions.map((runtime) => (
              <div key={runtime.cli} className="rounded-xl border border-border/60 bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-foreground">{runtime.label}</p>
                  <Badge variant="outline" className="text-muted-foreground">
                    {runtime.supportsReasoningEffort ? 'reasoning' : 'standard'}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{runtime.models.length} 个模型 · 默认 {runtime.defaultModel}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {runtime.models.map((model) => (
                    <Badge key={model.id} className="border-primary/20 bg-primary/5 text-primary">
                      {model.name}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-foreground">链路模拟结果</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  dry-run 会验证选择、运行器、脚本、目录、报告解析和修复单存储。
                </p>
              </div>
              {flowSimulation && (
                <Badge className={flowSimulation.ready ? 'border-emerald-200/60 bg-emerald-50 text-emerald-700' : 'border-red-200/60 bg-red-50 text-red-700'}>
                  {flowSimulation.ready ? '可运行' : '有阻断'}
                </Badge>
              )}
            </div>

            {flowSimulation ? (
              <div className="mt-4 space-y-2">
                {flowSimulation.steps.map((step) => (
                  <div key={step.id} className={`rounded-xl border px-3 py-2 ${flowStepClass(step.status)}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{step.name}</p>
                        <p className="mt-1 text-xs">{step.summary}</p>
                        {step.detail && <p className="mt-1 truncate font-mono text-xs opacity-80">{step.detail}</p>}
                      </div>
                      <span className="shrink-0 text-xs font-semibold">{step.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 rounded-xl border border-dashed border-border/60 bg-card p-6 text-center text-sm text-muted-foreground">
                点击“模拟链路”后查看每一步状态。
              </p>
            )}
          </div>
        </div>
      </Panel>

      <div className="space-y-5">
        <Panel title="当前选择" icon={<SlidersHorizontal className="h-4 w-4 text-primary" />}>
          <div className="space-y-3 p-4 text-sm">
            <div className="rounded-xl bg-muted/60 p-3">
              <p className="text-xs text-muted-foreground">评测集</p>
              <p className="mt-1 font-semibold text-foreground">{selectedEvalSet.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{selectedEvalSet.caseIds.length} 个用例</p>
            </div>
            <div className="rounded-xl bg-muted/60 p-3">
              <p className="text-xs text-muted-foreground">运行器</p>
              <p className="mt-1 font-semibold text-foreground">
                {benchmarkRuntime.label} · {benchmarkModel || benchmarkRuntime.defaultModel}
              </p>
            </div>
            <Button className="w-full" onClick={onStart} disabled={isStarting}>
              {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              启动真实评测
            </Button>
          </div>
        </Panel>

        <Panel title="执行命令" icon={<FileText className="h-4 w-4 text-muted-foreground" />}>
          <div className="p-4">
            <pre className="max-h-48 max-w-full whitespace-pre-wrap break-all rounded-xl bg-foreground p-3 text-xs text-background">
              {flowSimulation?.command.join(' ') ?? '尚未生成 dry-run 命令'}
            </pre>
          </div>
        </Panel>
      </div>
    </section>
  );
}
