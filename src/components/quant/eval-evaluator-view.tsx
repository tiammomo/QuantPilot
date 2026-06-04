import {
  Bot,
  CheckCircle2,
  Cpu,
  Eye,
  Loader2,
  Play,
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
import type { QuantEvalFlowSimulation } from '@/lib/quant/evals';
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
    cli: 'claude',
    model: 'mimo-v2.5-pro',
    defaultConcurrency: 4,
    maxConcurrency: 8,
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
    cli: 'codex',
    model: 'gpt-5.5',
    reasoningEffort: 'low',
    defaultConcurrency: 2,
    maxConcurrency: 4,
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
    cli: 'claude',
    model: 'mimo-v2.5-pro',
    defaultConcurrency: 2,
    maxConcurrency: 4,
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

  const updateConcurrency = (value: number) => {
    onConcurrencyChange(clampConcurrency(value, selectedEvaluator.maxConcurrency));
  };

  return (
    <section>
      <Panel
        title="评测器配置"
        icon={<Cpu className="h-4 w-4 text-primary" />}
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onSimulateFlow} disabled={isSimulatingFlow}>
              {isSimulatingFlow ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              模拟链路
            </Button>
            <Button size="sm" onClick={onStart} disabled={isStarting}>
              {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              启动真实评测
            </Button>
          </div>
        }
      >
        <div className="space-y-5 p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
            <ConfigField label="评测范围">
              <EvalSelect
                value={selectedEvalSetId}
                onValueChange={onEvalSetSelect}
                options={evalSets.map((evalSet) => ({
                  value: evalSet.id,
                  label: `${evalSet.name}（${evalSet.caseIds.length}）`,
                }))}
              />
            </ConfigField>

            <ConfigField label="并发数限制">
              <div className="flex h-9 items-center gap-2">
                <div className="flex h-9 rounded-lg border border-border/50 bg-card/60 p-1">
                  {CONCURRENCY_PRESETS.filter((value) => value <= selectedEvaluator.maxConcurrency).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => updateConcurrency(value)}
                      className={cn(
                        'h-7 min-w-9 rounded-md px-2 text-xs font-semibold transition-colors',
                        activeConcurrency === value
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={1}
                  max={selectedEvaluator.maxConcurrency}
                  value={activeConcurrency}
                  onChange={(event) => updateConcurrency(Number(event.target.value))}
                  className="h-9 w-20 rounded-lg border border-border/50 bg-card/60 px-3 text-center text-sm font-semibold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10"
                  aria-label="并发数限制"
                />
              </div>
            </ConfigField>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            {EVAL_EVALUATOR_OPTIONS.map((option) => {
              const Icon = EVALUATOR_ICONS[option.id];
              const isSelected = option.id === selectedEvaluator.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onEvaluatorSelect(option.id)}
                  className={cn(
                    'flex min-h-[248px] flex-col rounded-lg border bg-card p-4 text-left shadow-sm transition',
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

          <div className="rounded-lg border border-border/40 bg-card/60 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-foreground">链路模拟结果</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  dry-run 会验证评测器、用例范围、并发参数、脚本入口、报告解析和修复单存储。
                </p>
              </div>
              {flowSimulation && (
                <Badge className={flowSimulation.ready ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : 'border-red-500/30 bg-red-500/10 text-red-500'}>
                  {flowSimulation.ready ? 'Ready' : 'Blocked'}
                </Badge>
              )}
            </div>

            {flowSimulation ? (
              <div className="mt-4 space-y-2">
                {flowSimulation.steps.map((step) => (
                  <div key={step.id} className={cn('rounded-lg border px-3 py-2', flowStepClass(step.status))}>
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
              <p className="mt-4 rounded-lg border border-dashed border-border/60 bg-background/60 p-6 text-center text-sm text-muted-foreground">
                点击“模拟链路”后查看每一步状态。
              </p>
            )}
          </div>
        </div>
      </Panel>
    </section>
  );
}
