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
        icon={<Cpu className="h-4 w-4 text-blue-600" />}
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
                <div className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500">
                  不适用
                </div>
              )}
            </ConfigField>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {runtimeOptions.map((runtime) => (
              <div key={runtime.cli} className="rounded-md border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-slate-900">{runtime.label}</p>
                  <Badge variant="outline" className="bg-white text-slate-500">
                    {runtime.supportsReasoningEffort ? 'reasoning' : 'standard'}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-slate-500">{runtime.models.length} 个模型 · 默认 {runtime.defaultModel}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {runtime.models.map((model) => (
                    <Badge key={model.id} className="border-blue-100 bg-blue-50 text-blue-700 hover:bg-blue-50">
                      {model.name}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">链路模拟结果</p>
                <p className="mt-1 text-xs text-slate-500">
                  dry-run 会验证选择、运行器、脚本、目录、报告解析和修复单存储。
                </p>
              </div>
              {flowSimulation && (
                <Badge className={flowSimulation.ready ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}>
                  {flowSimulation.ready ? '可运行' : '有阻断'}
                </Badge>
              )}
            </div>

            {flowSimulation ? (
              <div className="mt-4 space-y-2">
                {flowSimulation.steps.map((step) => (
                  <div key={step.id} className={`rounded-md border px-3 py-2 ${flowStepClass(step.status)}`}>
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
              <p className="mt-4 rounded-md border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                点击“模拟链路”后查看每一步状态。
              </p>
            )}
          </div>
        </div>
      </Panel>

      <div className="space-y-5">
        <Panel title="当前选择" icon={<SlidersHorizontal className="h-4 w-4 text-blue-600" />}>
          <div className="space-y-3 p-4 text-sm">
            <div className="rounded-md bg-slate-50 p-3">
              <p className="text-xs text-slate-500">评测集</p>
              <p className="mt-1 font-semibold text-slate-900">{selectedEvalSet.name}</p>
              <p className="mt-1 text-xs text-slate-500">{selectedEvalSet.caseIds.length} 个用例</p>
            </div>
            <div className="rounded-md bg-slate-50 p-3">
              <p className="text-xs text-slate-500">运行器</p>
              <p className="mt-1 font-semibold text-slate-900">
                {benchmarkRuntime.label} · {benchmarkModel || benchmarkRuntime.defaultModel}
              </p>
            </div>
            <Button className="w-full bg-blue-600 text-white hover:bg-blue-700" onClick={onStart} disabled={isStarting}>
              {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              启动真实评测
            </Button>
          </div>
        </Panel>

        <Panel title="执行命令" icon={<FileText className="h-4 w-4 text-slate-600" />}>
          <div className="p-4">
            <pre className="max-h-48 max-w-full whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 text-xs text-slate-100">
              {flowSimulation?.command.join(' ') ?? '尚未生成 dry-run 命令'}
            </pre>
          </div>
        </Panel>
      </div>
    </section>
  );
}
