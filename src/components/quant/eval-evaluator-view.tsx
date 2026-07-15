import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Cpu,
  Eye,
  Gauge,
  Layers3,
  Loader2,
  Play,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ConfigField,
  EvalSelect,
  Panel,
  flowStepClass,
  type EvalSet,
} from '@/components/quant/eval-console-primitives';
import type { QuantEvalFlowSimulation } from '@/lib/eval';
import type { QuantEvalExecutionMode } from '@/lib/eval';
import { cn } from '@/lib/utils';

export type EvalEvaluatorId = 'rule-strict' | 'agent-review' | 'visual-contract';

export type EvalEvaluatorOption = {
  id: EvalEvaluatorId;
  name: string;
  subtitle: string;
  description: string;
  modeLabel: string;
  strategyLabel: string;
  cli: string;
  model: string;
  reasoningEffort?: string;
  defaultConcurrency: number;
  maxConcurrency: number;
  executionMode: QuantEvalExecutionMode;
  checks: string[];
  highlights: string[];
};

export const EVAL_EVALUATOR_OPTIONS: EvalEvaluatorOption[] = [
  {
    id: 'rule-strict',
    name: '强规则评测器',
    subtitle: '确定性校验',
    description: '围绕产物结构、数据证据、字段契约和事件链路做硬性规则判断。',
    modeLabel: '规则优先',
    strategyLabel: '快速、稳定、适合批量回归',
    cli: 'moagent',
    model: 'deepseek-v4-flash',
    defaultConcurrency: 4,
    maxConcurrency: 8,
    executionMode: 'contract',
    checks: ['产物契约', '数据证据', '事件审计', '视觉基础检查'],
    highlights: ['低成本', '高一致性', '失败原因明确'],
  },
  {
    id: 'agent-review',
    name: 'Agent 评测器',
    subtitle: '智能体审阅',
    description: '用 Agent 视角检查任务理解、业务完整性、修复建议和最终交付质量。',
    modeLabel: 'Agent 复核',
    strategyLabel: '适合复杂 Query 和主观质量判断',
    cli: 'moagent',
    model: 'deepseek-v4-flash',
    defaultConcurrency: 2,
    maxConcurrency: 4,
    executionMode: 'e2e',
    checks: ['意图覆盖', '业务解释', '风险提示', '修复建议'],
    highlights: ['质量审阅', '解释充分', '适合抽检'],
  },
  {
    id: 'visual-contract',
    name: '视觉契约评测器',
    subtitle: '页面与证据联动',
    description: '关注截图、图表、关键文本、数据降级提示和前端展示契约。',
    modeLabel: '视觉合同',
    strategyLabel: '适合看板类项目和截图用例',
    cli: 'moagent',
    model: 'deepseek-v4-flash',
    defaultConcurrency: 2,
    maxConcurrency: 4,
    executionMode: 'contract',
    checks: ['截图可用性', '图表存在性', '文本完整性', '降级提示'],
    highlights: ['页面导向', '证据联动', '展示稳定性'],
  },
];

export function getEvalEvaluatorOption(id: string): EvalEvaluatorOption {
  return EVAL_EVALUATOR_OPTIONS.find((option) => option.id === id) ?? EVAL_EVALUATOR_OPTIONS[0];
}

const EVALUATOR_ICONS: Record<EvalEvaluatorId, typeof ShieldCheck> = {
  'rule-strict': ShieldCheck,
  'agent-review': Bot,
  'visual-contract': Eye,
};

const CONCURRENCY_PRESETS = [1, 2, 4, 8];

function clampConcurrency(value: number, max: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

type EvalEvaluatorViewProps = {
  selectedEvaluatorId: string;
  concurrency: number;
  evalSets: EvalSet[];
  selectedEvalSetId: string;
  flowSimulation: QuantEvalFlowSimulation | null;
  isSimulatingFlow: boolean;
  isStarting: boolean;
  onEvaluatorSelect: (evaluatorId: EvalEvaluatorId) => void;
  onConcurrencyChange: (concurrency: number) => void;
  onEvalSetSelect: (evalSetId: string) => void;
  onSimulateFlow: () => void;
  onStart: () => void;
};

export function EvalEvaluatorView({
  selectedEvaluatorId,
  concurrency,
  evalSets,
  selectedEvalSetId,
  flowSimulation,
  isSimulatingFlow,
  isStarting,
  onEvaluatorSelect,
  onConcurrencyChange,
  onEvalSetSelect,
  onSimulateFlow,
  onStart,
}: EvalEvaluatorViewProps) {
  const selectedEvaluator = getEvalEvaluatorOption(selectedEvaluatorId);
  const activeConcurrency = clampConcurrency(concurrency, selectedEvaluator.maxConcurrency);
  const selectedEvalSet = evalSets.find((evalSet) => evalSet.id === selectedEvalSetId) ?? evalSets[0];

  const updateConcurrency = (value: number) => {
    onConcurrencyChange(clampConcurrency(value, selectedEvaluator.maxConcurrency));
  };

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.12] via-card to-card p-5 shadow-[0_24px_60px_-42px_hsl(var(--shadow-color)/0.65)] sm:p-6">
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-primary">
              <Gauge className="h-4 w-4" />
              本次评测计划
            </div>
            <h2 className="mt-3 truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl">{selectedEvalSet?.name ?? '全部用例'}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {selectedEvalSet?.caseIds.length ?? 0} 条用例 · {selectedEvaluator.name} · 并发 {activeConcurrency}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge variant="outline" className="border-primary/20 bg-background/60 text-primary">{selectedEvaluator.modeLabel}</Badge>
              <Badge variant="outline" className="border-border/60 bg-background/60 text-muted-foreground">{selectedEvaluator.cli} / {selectedEvaluator.model}</Badge>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={onSimulateFlow} disabled={isSimulatingFlow} className="gap-2 bg-background/70">
              {isSimulatingFlow ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              模拟执行链路
            </Button>
            <Button onClick={onStart} disabled={isStarting} className="gap-2 shadow-md shadow-primary/15">
              {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {selectedEvaluator.executionMode === 'e2e' ? '启动 DeepSeek E2E' : '启动契约评测'}
            </Button>
          </div>
        </div>
      </section>

      <Panel title="选择评测策略" icon={<Cpu className="h-4 w-4 text-primary" />} action={<span className="text-xs text-muted-foreground">3 种内置策略</span>}>
        <div className="grid gap-3 p-4 lg:grid-cols-3">
            {EVAL_EVALUATOR_OPTIONS.map((option) => {
              const Icon = EVALUATOR_ICONS[option.id];
              const isSelected = option.id === selectedEvaluator.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onEvaluatorSelect(option.id)}
                  className={cn(
                    'flex min-h-[232px] flex-col rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5',
                    isSelected
                      ? 'border-primary/60 bg-primary/5 ring-2 ring-primary/10'
                      : 'border-border/50 hover:border-primary/35 hover:bg-primary/5',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', isSelected ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary')}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground">{option.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{option.subtitle}</p>
                      </div>
                    </div>
                    {isSelected && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                  </div>

                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{option.description}</p>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
                      {option.modeLabel}
                    </Badge>
                    <Badge variant="secondary" className="bg-muted text-muted-foreground">
                      最高 {option.maxConcurrency} 并发
                    </Badge>
                  </div>

                  <div className="mt-4 space-y-2">
                    {option.checks.slice(0, 3).map((item) => (
                      <div key={item} className="flex items-center gap-2 text-xs text-foreground">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>

                  <p className="mt-auto pt-4 text-xs text-muted-foreground">{option.strategyLabel}</p>
                </button>
              );
            })}
        </div>
      </Panel>

      <section className="grid gap-5 xl:grid-cols-[0.82fr_1.18fr]">
        <Panel title="运行参数" icon={<Settings2 className="h-4 w-4 text-primary" />}>
          <div className="space-y-5 p-5">
            <ConfigField label="评测范围">
              <EvalSelect
                value={selectedEvalSetId}
                onValueChange={onEvalSetSelect}
                options={evalSets.map((evalSet) => ({ value: evalSet.id, label: `${evalSet.name}（${evalSet.caseIds.length}）` }))}
                className="h-10"
              />
            </ConfigField>

            <ConfigField label="并发数限制">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex h-10 rounded-lg border border-border/50 bg-background p-1">
                  {CONCURRENCY_PRESETS.filter((value) => value <= selectedEvaluator.maxConcurrency).map((value) => (
                    <button key={value} type="button" onClick={() => updateConcurrency(value)} className={cn('h-8 min-w-10 rounded-md px-2 text-xs font-semibold transition-colors', activeConcurrency === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                      {value}
                    </button>
                  ))}
                </div>
                <input type="number" min={1} max={selectedEvaluator.maxConcurrency} value={activeConcurrency} onChange={(event) => updateConcurrency(Number(event.target.value))} className="h-10 w-20 rounded-lg border border-border/50 bg-background px-3 text-center text-sm font-semibold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10" aria-label="并发数限制" />
              </div>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">该策略最高支持 {selectedEvaluator.maxConcurrency} 个任务并发。更高并发会增加运行时资源占用。</p>
            </ConfigField>

            <div className="rounded-xl border border-border/50 bg-muted/25 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground"><Layers3 className="h-4 w-4 text-primary" />执行摘要</div>
              <dl className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">评测用例</dt><dd className="font-semibold text-foreground">{selectedEvalSet?.caseIds.length ?? 0} 条</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">执行模式</dt><dd className="font-semibold text-foreground">{selectedEvaluator.executionMode === 'e2e' ? '真实 Agent' : '确定性模板'}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">运行模型</dt><dd className="truncate font-mono text-foreground">{selectedEvaluator.executionMode === 'e2e' ? selectedEvaluator.model : '不调用模型'}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">检查项</dt><dd className="font-semibold text-foreground">{selectedEvaluator.checks.length} 项</dd></div>
              </dl>
            </div>
          </div>
        </Panel>

        <Panel title="链路模拟" icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />} action={flowSimulation ? <Badge className={flowSimulation.ready ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : 'border-red-500/30 bg-red-500/10 text-red-500'}>{flowSimulation.ready ? '可以启动' : '存在阻断'}</Badge> : <Badge variant="outline" className="text-muted-foreground">尚未模拟</Badge>}>
          <div className="p-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-foreground">启动前检查</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  模拟会验证评测器、用例范围、并发参数、脚本入口与报告解析，全程不会产生真实评测报告。
                </p>
              </div>
            </div>

            {flowSimulation ? (
              <div className="mt-4 space-y-2">
                {flowSimulation.steps.map((step) => (
                  <div key={step.id} className={cn('rounded-xl border px-3.5 py-3', flowStepClass(step.status))}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{step.name}</p>
                        <p className="mt-1 text-xs">{step.summary}</p>
                        {step.detail && <p className="mt-1 truncate font-mono text-xs opacity-80">{step.detail}</p>}
                      </div>
                      <span className="shrink-0 text-xs font-semibold">{step.status === 'passed' ? '通过' : step.status === 'warning' ? '警告' : '阻断'}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <button type="button" onClick={onSimulateFlow} disabled={isSimulatingFlow} className="group mt-5 flex min-h-44 w-full flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-background/55 p-6 text-center transition-colors hover:border-primary/35 hover:bg-primary/5">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldCheck className="h-5 w-5" /></span>
                <span className="mt-3 text-sm font-semibold text-foreground">先验证完整执行链路</span>
                <span className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">检查配置与运行环境，避免真实评测开始后才发现阻断项。</span>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary">开始模拟 <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
              </button>
            )}
          </div>
        </Panel>
      </section>
    </div>
  );
}
