import type { ReactNode } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type {
  QuantEvalDashboardData,
  QuantEvalFlowSimulation,
  QuantEvalQueueItem,
  QuantEvalResult,
  QuantEvalRun,
  QuantEvalRuntimeOption,
} from '@/lib/eval';

export type EvalSet = {
  id: string;
  name: string;
  description: string;
  category: string;
  caseIds: string[];
  custom?: boolean;
};

export type EvalView = 'overview' | 'cases' | 'evalSets' | 'evaluator' | 'queue';

export const CLI_LABELS: Record<string, string> = {
  claude: 'DeepSeek Agent',
};

export const FALLBACK_RUNTIME: QuantEvalRuntimeOption = {
  cli: 'claude',
  label: 'DeepSeek Agent',
  defaultModel: 'deepseek-v4-flash',
  supportsReasoningEffort: false,
  models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'DeepSeek 官方 API 直连' }],
};

export const selectClassName =
  'h-9 w-full rounded-lg border border-border/40 bg-card/60 px-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50';

export type EvalSelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

export function EvalSelect({
  value,
  options,
  onValueChange,
  placeholder = '请选择',
  className,
  contentClassName,
  disabled,
}: {
  value: string;
  options: EvalSelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName} position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function paginationItems(page: number, pageCount: number): Array<number | 'ellipsis'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  if (page <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', pageCount];
  }

  if (page >= pageCount - 3) {
    return [1, 'ellipsis', pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  }

  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', pageCount];
}

export function EvalPagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
}: {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
}) {
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(pageCount, Math.max(1, page));
  const start = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(totalItems, currentPage * pageSize);
  const goToPage = (nextPage: number) => onPageChange(Math.min(pageCount, Math.max(1, nextPage)));

  return (
    <div className="flex flex-col gap-3 border-t border-border/40 px-4 py-3 text-xs text-muted-foreground lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-3">
        <span>
          显示 {start}-{end} / 共 {totalItems} 条
        </span>
        <EvalSelect
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange(Number(value))}
          options={pageSizeOptions.map((option) => ({
            value: String(option),
            label: `${option} 条/页`,
          }))}
          className="h-8 w-[112px] rounded-md text-xs"
          contentClassName="min-w-[112px]"
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          className="h-8 w-8 text-muted-foreground"
          aria-label="上一页"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div className="flex items-center gap-1">
          {paginationItems(currentPage, pageCount).map((item, index) =>
            item === 'ellipsis' ? (
              <span key={`ellipsis-${index}`} className="flex h-8 min-w-8 items-center justify-center text-muted-foreground">
                ...
              </span>
            ) : (
              <button
                key={item}
                type="button"
                onClick={() => goToPage(item)}
                className={cn(
                  'flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors',
                  item === currentPage
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-foreground hover:bg-muted',
                )}
              >
                {item}
              </button>
            ),
          )}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= pageCount}
          className="h-8 w-8 text-muted-foreground"
          aria-label="下一页"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const raw = Number(formData.get('page'));
            if (Number.isFinite(raw)) goToPage(raw);
          }}
        >
          <span>跳至</span>
          <input
            name="page"
            type="number"
            min={1}
            max={pageCount}
            className="h-8 w-12 rounded-md border border-border/50 bg-background px-2 text-center text-xs text-foreground outline-none transition focus:ring-2 focus:ring-primary/15"
            aria-label="跳转页码"
          />
          <span>页</span>
        </form>
      </div>
    </div>
  );
}

export const EVAL_SET_PAGE_SIZE = 9;

export function formatDuration(value: number) {
  if (!value) return '-';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`;
  return `${Math.round(value / 60_000)} 分钟`;
}

export function scoreClass(score: number) {
  if (score >= 90) return 'text-emerald-400';
  if (score >= 75) return 'text-amber-400';
  return 'text-red-400';
}

export function passRateClass(rate: number) {
  if (rate >= 95) return 'text-emerald-400';
  if (rate >= 80) return 'text-amber-400';
  return 'text-red-400';
}

export function statusPill(result?: QuantEvalResult) {
  if (!result) {
    return (
      <Badge variant="outline" className="inline-flex whitespace-nowrap border-border/40 bg-muted/20 text-muted-foreground">
        未运行
      </Badge>
    );
  }

  if (result.passed) {
    return (
      <Badge className="inline-flex whitespace-nowrap border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/10">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        通过
      </Badge>
    );
  }

  return (
    <Badge className="inline-flex whitespace-nowrap border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/10">
      <XCircle className="mr-1 h-3 w-3" />
      失败
    </Badge>
  );
}

export function queueBadge(status: QuantEvalQueueItem['status']) {
  const config: Record<QuantEvalQueueItem['status'], { className: string; label: string }> = {
    queued: { className: 'border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/10', label: '排队中' },
    running: { className: 'border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/10', label: '运行中' },
    passed: { className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/10', label: '已通过' },
    failed: { className: 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/10', label: '已失败' },
    cancelled: { className: 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-muted/20', label: '已取消' },
  };
  return <Badge className={config[status].className}>{config[status].label}</Badge>;
}

export function hasActiveQueue(queue: QuantEvalQueueItem[]) {
  return queue.some((item) => item.status === 'queued' || item.status === 'running');
}

export function getLatestRunDelta(runs: QuantEvalRun[]) {
  if (runs.length < 2) return null;
  const [latest, previous] = runs;
  return {
    passRate: latest.passRate - previous.passRate,
    score: latest.averageScore - previous.averageScore,
    failed: latest.failedCount - previous.failedCount,
  };
}

export function getRuntimeOption(runtimeOptions: QuantEvalRuntimeOption[], cli: string) {
  return runtimeOptions.find((option) => option.cli === cli) ?? runtimeOptions[0] ?? FALLBACK_RUNTIME;
}

export function getInitialRuntime(data: QuantEvalDashboardData) {
  return data.runtimeOptions.find((option) => option.cli === 'claude') ?? data.runtimeOptions[0] ?? FALLBACK_RUNTIME;
}

export function getReasoningEffort(runtime: QuantEvalRuntimeOption, value: string | null | undefined) {
  return runtime.supportsReasoningEffort ? value || 'low' : '';
}

export function buildEvalSets(data: QuantEvalDashboardData): EvalSet[] {
  const cases = data.cases;
  const sets: EvalSet[] = [
    {
      id: 'all',
      name: '全部用例',
      description: '覆盖所有能力域、输入类型和验证契约。',
      category: '系统',
      caseIds: cases.map((testCase) => testCase.id),
    },
  ];

  const byCapability = new Map<string, typeof cases>();
  const byType = new Map<string, typeof cases>();
  for (const testCase of cases) {
    byCapability.set(testCase.capabilityId, [...(byCapability.get(testCase.capabilityId) ?? []), testCase]);
    byType.set(testCase.type, [...(byType.get(testCase.type) ?? []), testCase]);
  }

  for (const [capabilityId, items] of byCapability) {
    sets.push({
      id: `capability:${capabilityId}`,
      name: items[0]?.capabilityLabel ?? capabilityId,
      description: `${capabilityId} 能力域回归集。`,
      category: '能力',
      caseIds: items.map((item) => item.id),
    });
  }

  for (const [type, items] of byType) {
    sets.push({
      id: `type:${type}`,
      name: items[0]?.typeLabel ?? type,
      description: `${type} 输入/产物类型回归集。`,
      category: '类型',
      caseIds: items.map((item) => item.id),
    });
  }

  const visualCases = cases.filter((testCase) => testCase.visualCheck || testCase.hasImageAttachment);
  if (visualCases.length > 0) {
    sets.push({
      id: 'special:visual',
      name: '视觉与截图',
      description: '覆盖截图识别、视觉冒烟和页面关键词检查。',
      category: '专项',
      caseIds: visualCases.map((item) => item.id),
    });
  }

  const clarificationCases = cases.filter((testCase) => testCase.expectClarification || testCase.type.includes('clarification'));
  if (clarificationCases.length > 0) {
    sets.push({
      id: 'special:clarification',
      name: '澄清链路',
      description: '覆盖缺失信息澄清和澄清后的上下文承接。',
      category: '专项',
      caseIds: clarificationCases.map((item) => item.id),
    });
  }

  const knownCaseIds = new Set(cases.map((testCase) => testCase.id));
  const customSets = (data.customEvalSets ?? []).map((evalSet) => ({
    id: evalSet.id,
    name: evalSet.name,
    description: evalSet.description,
    category: evalSet.category || '自定义',
    caseIds: evalSet.caseIds.filter((caseId) => knownCaseIds.has(caseId)),
    custom: evalSet.custom,
  }));

  return [...sets, ...customSets.filter((evalSet) => evalSet.caseIds.length > 0)];
}

export function DeltaText({ value, suffix = '' }: { value: number; suffix?: string }) {
  if (!value) return null;
  return (
    <span className={value > 0 ? 'text-xs font-medium text-emerald-400' : 'text-xs font-medium text-red-400'}>
      {value > 0 ? '+' : ''}{value}{suffix}
    </span>
  );
}

export function StatTile({
  icon,
  label,
  value,
  helper,
  tone = 'slate',
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  helper: ReactNode;
  tone?: 'blue' | 'emerald' | 'amber' | 'red' | 'slate';
}) {
  const toneConfig = {
    blue: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-400' },
    red: { bg: 'bg-red-500/10', text: 'text-red-400' },
    slate: { bg: 'bg-muted/40', text: 'text-muted-foreground' },
  }[tone];

  return (
    <div className="rounded-xl border border-slate-200/80 bg-card/85 px-3.5 py-3.5 shadow-[0_14px_34px_-30px_hsl(var(--shadow-color)/0.55)] backdrop-blur sm:px-5 sm:py-4 dark:border-border/50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <div className="mt-2 flex items-baseline gap-2 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            {value}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{helper}</div>
        </div>
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 ${toneConfig.bg} ${toneConfig.text}`}>
          {icon}
        </div>
      </div>
    </div>
  );
}

export function Panel({
  title,
  icon,
  children,
  action,
  className,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-xl border border-slate-200/80 bg-card/85 shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)] backdrop-blur dark:border-border/50 ${className ?? ''}`}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-200/70 px-5 py-3 dark:border-border/30">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {icon}
          <h2>{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ConfigField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

export function getEvalSetStats(evalSet: EvalSet, latestResultByCase: Map<string, QuantEvalResult>) {
  const results = evalSet.caseIds
    .map((caseId) => latestResultByCase.get(caseId))
    .filter((result): result is QuantEvalResult => Boolean(result));
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const passRate = results.length ? Math.round((passed / results.length) * 100) : null;

  return {
    ran: results.length,
    passed,
    failed,
    passRate,
  };
}

export function flowStepClass(status: QuantEvalFlowSimulation['steps'][number]['status']) {
  if (status === 'passed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
  if (status === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
  return 'border-red-500/30 bg-red-500/10 text-red-400';
}
