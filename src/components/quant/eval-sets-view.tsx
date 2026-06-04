import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  CheckCircle2,
  Clock3,
  Database,
  FolderOpen,
  Hourglass,
  ListFilter,
  LayoutList,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Upload,
  UserRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  EvalPagination,
  EvalSelect,
  passRateClass,
  type EvalSet,
} from '@/components/quant/eval-console-primitives';
import type { QuantEvalCase, QuantEvalRun } from '@/lib/quant/evals';
import { cn } from '@/lib/utils';

type RunStateFilter = 'all' | 'ran' | 'not-run';
type OwnerFilter = 'all' | 'mine' | 'unassigned';
type SourceFilter = 'all' | 'builtin' | 'custom';

type EvalSetRunSummary = {
  latestRun: QuantEvalRun | null;
  latestPassRate: number | null;
  owner: string;
  feedbackPassRate: number | null;
};

type EvalSetsViewProps = {
  cases: QuantEvalCase[];
  runs: QuantEvalRun[];
  evalSets: EvalSet[];
  filteredEvalSets: EvalSet[];
  selectedEvalSet: EvalSet;
  evalSetKeyword: string;
  evalSetCategoryFilter: string;
  evalSetCategories: string[];
  evalSetPage: number;
  evalSetPageSize: number;
  isStarting: boolean;
  onEvalSetKeywordChange: (keyword: string) => void;
  onEvalSetCategoryFilterChange: (category: string) => void;
  onEvalSetSelect: (evalSetId: string) => void;
  onEvalSetPageChange: (updater: (page: number) => number) => void;
  onEvalSetPageSizeChange: (pageSize: number) => void;
  onCreateEvalSet: (payload: Record<string, unknown>) => Promise<void>;
  onRunEvalSet: (evalSetId: string) => void;
};

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

function runCoversEvalSet(run: QuantEvalRun, evalSet: EvalSet) {
  const selectedCaseIds = run.metadata.selection.selectedCases;
  if (evalSet.id === 'all') return selectedCaseIds.length === 0;
  if (selectedCaseIds.length === 0) return true;
  const selectedCaseIdSet = new Set(selectedCaseIds);
  return evalSet.caseIds.every((caseId) => selectedCaseIdSet.has(caseId));
}

function getEvalSetPassRateFromRun(run: QuantEvalRun, evalSet: EvalSet) {
  if (!runCoversEvalSet(run, evalSet)) return null;

  const resultById = new Map(run.results.map((result) => [result.id, result]));
  const resultByName = new Map(run.results.map((result) => [result.name, result]));
  const results = evalSet.caseIds
    .map((caseId) => resultById.get(caseId) ?? resultByName.get(caseId))
    .filter((result): result is QuantEvalRun['results'][number] => Boolean(result));

  if (!results.length) return null;
  if (evalSet.id === 'all' && results.length < evalSet.caseIds.length) return null;

  const passed = results.filter((result) => result.passed).length;
  return Math.round((passed / results.length) * 100);
}

function getOwnerLabel(evalSet: EvalSet) {
  if (evalSet.custom) return '测试';
  return '-';
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className={cn(
        'h-9 gap-1.5 rounded-full border-border/50 bg-background px-3 text-xs text-muted-foreground shadow-none',
        active && 'border-primary/40 bg-primary/10 text-primary',
      )}
    >
      {children}
    </Button>
  );
}

function MetricCard({
  icon,
  label,
  value,
  tone = 'blue',
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone?: 'blue' | 'emerald' | 'amber' | 'violet';
}) {
  const toneClass = {
    blue: 'bg-blue-500/10 text-blue-500',
    emerald: 'bg-emerald-500/10 text-emerald-500',
    amber: 'bg-amber-500/10 text-amber-500',
    violet: 'bg-violet-500/10 text-violet-500',
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

function CreateEvalSetSheet({
  open,
  onOpenChange,
  cases,
  onCreateEvalSet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cases: QuantEvalCase[];
  onCreateEvalSet: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('自定义');
  const [keyword, setKeyword] = useState('');
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredCases = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return cases;
    return cases.filter((testCase) =>
      [testCase.id, testCase.name, testCase.question, testCase.capabilityLabel, testCase.typeLabel, ...testCase.tags]
        .join(' ')
        .toLowerCase()
        .includes(kw),
    );
  }, [cases, keyword]);

  const reset = () => {
    setId('');
    setName('');
    setDescription('');
    setCategory('自定义');
    setKeyword('');
    setSelectedCaseIds(new Set());
    setError(null);
  };

  const toggleCase = (caseId: string) => {
    setSelectedCaseIds((current) => {
      const next = new Set(current);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[min(600px,calc(100vw-24px))] max-w-none flex-col gap-0 overflow-hidden border-l border-border bg-background p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border/40 bg-background/95 px-5 py-4 backdrop-blur-xl">
          <SheetTitle className="text-base">创建评测集</SheetTitle>
          <SheetDescription className="text-xs">
            自定义评测集会写入 benchmarks/quantpilot/eval-sets.json，可直接参与运行和筛选。
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex flex-1 flex-col overflow-hidden"
          onSubmit={async (event) => {
            event.preventDefault();
            setIsSaving(true);
            setError(null);
            try {
              await onCreateEvalSet({
                id: id.trim() || undefined,
                name: name.trim(),
                description: description.trim(),
                category: category.trim() || '自定义',
                caseIds: Array.from(selectedCaseIds),
              });
              reset();
              onOpenChange(false);
            } catch (submitError) {
              setError(submitError instanceof Error ? submitError.message : String(submitError));
            } finally {
              setIsSaving(false);
            }
          }}
        >
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="eval-set-id">评测集 ID</Label>
                <Input id="eval-set-id" value={id} onChange={(event) => setId(event.target.value)} placeholder="留空自动生成" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eval-set-name">评测集名称</Label>
                <Input id="eval-set-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：数据链路回归" required />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="eval-set-category">分类</Label>
              <Input id="eval-set-category" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="自定义" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="eval-set-description">描述</Label>
              <Textarea id="eval-set-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述这个评测集覆盖的场景..." />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>包含用例</Label>
                <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">
                  {selectedCaseIds.size}/{cases.length}
                </Badge>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索用例..." className="pl-9" />
              </div>
              <div className="max-h-[360px] overflow-y-auto rounded-lg border border-border/50">
                {filteredCases.map((testCase) => (
                  <label key={testCase.id} className="flex cursor-pointer items-start gap-3 border-b border-border/30 px-3 py-3 last:border-b-0 hover:bg-muted/30">
                    <input
                      type="checkbox"
                      checked={selectedCaseIds.has(testCase.id)}
                      onChange={() => toggleCase(testCase.id)}
                      className="mt-0.5 h-4 w-4 rounded border-border bg-background"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-foreground">{testCase.name}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{testCase.id}</span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline" className="border-border/50 text-[10px] text-muted-foreground">{testCase.capabilityLabel}</Badge>
                        <Badge variant="outline" className="border-border/50 text-[10px] text-muted-foreground">{testCase.typeLabel}</Badge>
                      </span>
                    </span>
                  </label>
                ))}
                {!filteredCases.length && (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的用例。</div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
              取消
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              创建评测集
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function EvalSetsView({
  cases,
  runs,
  evalSets,
  filteredEvalSets,
  selectedEvalSet,
  evalSetKeyword,
  evalSetCategoryFilter,
  evalSetCategories,
  evalSetPage,
  evalSetPageSize,
  isStarting,
  onEvalSetKeywordChange,
  onEvalSetCategoryFilterChange,
  onEvalSetSelect,
  onEvalSetPageChange,
  onEvalSetPageSizeChange,
  onCreateEvalSet,
  onRunEvalSet,
}: EvalSetsViewProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [onlyWithCases, setOnlyWithCases] = useState(false);
  const [runStateFilter, setRunStateFilter] = useState<RunStateFilter>('all');
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const runSummaryBySet = useMemo(() => {
    const summaries = new Map<string, EvalSetRunSummary>();

    evalSets.forEach((evalSet) => {
      const latestMatchingRun = runs.find((run) => getEvalSetPassRateFromRun(run, evalSet) !== null) ?? null;
      summaries.set(evalSet.id, {
        latestRun: latestMatchingRun,
        latestPassRate: latestMatchingRun ? getEvalSetPassRateFromRun(latestMatchingRun, evalSet) : null,
        owner: getOwnerLabel(evalSet),
        feedbackPassRate: null,
      });
    });

    return summaries;
  }, [evalSets, runs]);

  const ranSetCount = evalSets.filter((evalSet) => Boolean(runSummaryBySet.get(evalSet.id)?.latestRun)).length;
  const notRunSetCount = Math.max(0, evalSets.length - ranSetCount);
  const averagePassRate =
    ranSetCount > 0
      ? Math.round(
          evalSets.reduce((sum, evalSet) => sum + (runSummaryBySet.get(evalSet.id)?.latestPassRate ?? 0), 0) / ranSetCount,
        )
      : null;

  const visibleEvalSets = useMemo(() => {
    return filteredEvalSets.filter((evalSet) => {
      const summary = runSummaryBySet.get(evalSet.id);
      if (ownerFilter === 'mine' && !evalSet.custom) return false;
      if (ownerFilter === 'unassigned' && evalSet.custom) return false;
      if (sourceFilter === 'builtin' && evalSet.custom) return false;
      if (sourceFilter === 'custom' && !evalSet.custom) return false;
      if (onlyWithCases && evalSet.caseIds.length === 0) return false;
      if (runStateFilter === 'ran' && !summary?.latestRun) return false;
      if (runStateFilter === 'not-run' && summary?.latestRun) return false;
      return true;
    });
  }, [filteredEvalSets, onlyWithCases, ownerFilter, runStateFilter, runSummaryBySet, sourceFilter]);

  const visiblePageCount = Math.max(1, Math.ceil(visibleEvalSets.length / evalSetPageSize));
  const currentPage = Math.min(evalSetPage, visiblePageCount);
  const pagedVisibleEvalSets = visibleEvalSets.slice(
    (currentPage - 1) * evalSetPageSize,
    currentPage * evalSetPageSize,
  );
  const selectedVisibleCount = pagedVisibleEvalSets.filter((evalSet) => selectedRowIds.has(evalSet.id)).length;
  const allVisibleSelected = pagedVisibleEvalSets.length > 0 && selectedVisibleCount === pagedVisibleEvalSets.length;

  const resetFilters = () => {
    onEvalSetKeywordChange('');
    onEvalSetCategoryFilterChange('all');
    setOwnerFilter('all');
    setSourceFilter('all');
    setOnlyWithCases(false);
    setRunStateFilter('all');
    onEvalSetPageChange(() => 1);
  };

  const toggleRow = (evalSetId: string) => {
    setSelectedRowIds((current) => {
      const next = new Set(current);
      if (next.has(evalSetId)) next.delete(evalSetId);
      else next.add(evalSetId);
      return next;
    });
  };

  const toggleVisibleRows = () => {
    setSelectedRowIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        pagedVisibleEvalSets.forEach((evalSet) => next.delete(evalSet.id));
      } else {
        pagedVisibleEvalSets.forEach((evalSet) => next.add(evalSet.id));
      }
      return next;
    });
  };

  const updateOwnerFilter = (value: string) => {
    setOwnerFilter(value as OwnerFilter);
    onEvalSetPageChange(() => 1);
  };

  const updateRunStateFilter = (value: RunStateFilter) => {
    setRunStateFilter((current) => (current === value ? 'all' : value));
    onEvalSetPageChange(() => 1);
  };

  const updateSourceFilter = (value: SourceFilter) => {
    setSourceFilter(value);
    onEvalSetPageChange(() => 1);
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportError(null);
    try {
      const parsed = JSON.parse(await file.text());
      const rawItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed.evalSets) ? parsed.evalSets : [parsed];
      const items = rawItems.filter((item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null);
      if (!items.length) throw new Error('导入文件中没有可用的评测集。');

      for (const item of items) {
        await onCreateEvalSet({
          id: typeof item.id === 'string' ? item.id : undefined,
          name: typeof item.name === 'string' ? item.name : '',
          description: typeof item.description === 'string' ? item.description : '',
          category: typeof item.category === 'string' ? item.category : '自定义',
          caseIds: Array.isArray(item.caseIds) ? item.caseIds.map(String) : [],
        });
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-xl font-bold tracking-normal text-foreground">评测集</h2>
          <Badge variant="secondary" className="h-6 rounded-md px-2 text-xs">
            共 {evalSets.length} 个
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button variant="outline" size="sm" onClick={() => importInputRef.current?.click()} className="gap-1.5 border-border/50 text-xs">
            <Upload className="h-3.5 w-3.5" />
            导入
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" />
            创建评测集
          </Button>
        </div>
      </div>

      {importError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {importError}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<Database className="h-4 w-4" />} label="全部评测集" value={evalSets.length} />
        <MetricCard icon={<CheckCircle2 className="h-4 w-4" />} label="有运行结果" value={ranSetCount} tone="emerald" />
        <MetricCard icon={<Hourglass className="h-4 w-4" />} label="未运行" value={notRunSetCount} tone="amber" />
        <MetricCard
          icon={<Clock3 className="h-4 w-4" />}
          label="平均通过率"
          value={averagePassRate === null ? '-' : `${averagePassRate}%`}
          tone="violet"
        />
      </section>

      <section className="rounded-lg border border-border/50 bg-card shadow-sm">
        <div className="flex flex-col gap-4 border-b border-border/40 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <div className="relative min-w-[260px] flex-1 xl:max-w-[430px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={evalSetKeyword}
                  onChange={(event) => {
                    onEvalSetKeywordChange(event.target.value);
                    onEvalSetPageChange(() => 1);
                  }}
                  placeholder="搜索名称、ID 或标签..."
                  className="h-9 border-border/40 bg-background pl-9 text-sm"
                />
              </div>
              <EvalSelect
                value={ownerFilter}
                onValueChange={updateOwnerFilter}
                options={[
                  { value: 'all', label: '全部负责人' },
                  { value: 'mine', label: '我负责的' },
                  { value: 'unassigned', label: '未分配' },
                ]}
                className="h-9 w-[150px]"
                contentClassName="min-w-[150px]"
              />
              <EvalSelect
                value={evalSetCategoryFilter}
                onValueChange={(value) => {
                  onEvalSetCategoryFilterChange(value);
                  onEvalSetPageChange(() => 1);
                }}
                options={[
                  { value: 'all', label: '全部分类' },
                  ...evalSetCategories.map((category) => ({ value: category, label: category })),
                ]}
                className="h-9 w-[150px]"
                contentClassName="min-w-[150px]"
              />
              <FilterButton
                active={onlyWithCases}
                onClick={() => {
                  setOnlyWithCases((current) => !current);
                  onEvalSetPageChange(() => 1);
                }}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                有用例
              </FilterButton>
              <FilterButton active={runStateFilter === 'ran'} onClick={() => updateRunStateFilter('ran')}>
                <Clock3 className="h-3.5 w-3.5" />
                有运行结果
              </FilterButton>
              <FilterButton active={runStateFilter === 'not-run'} onClick={() => updateRunStateFilter('not-run')}>
                <Hourglass className="h-3.5 w-3.5" />
                未运行
              </FilterButton>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <div className="inline-flex h-9 items-center gap-1 rounded-md border border-border/50 bg-background px-3 text-xs text-foreground">
                <LayoutList className="h-3.5 w-3.5 text-muted-foreground" />
                显示列
                <Badge variant="secondary" className="ml-1 h-5 rounded px-1.5 text-[10px]">
                  {pagedVisibleEvalSets.length}/{visibleEvalSets.length}
                </Badge>
              </div>
              <Button variant="outline" size="sm" onClick={resetFilters} className="h-9 gap-1.5 border-border/50 text-xs">
                <RotateCcw className="h-3.5 w-3.5" />
                重置
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAdvancedFiltersOpen((current) => !current)}
                className={cn(
                  'h-9 gap-1.5 border-border/50 text-xs',
                  advancedFiltersOpen && 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/10',
                )}
              >
                <ListFilter className="h-3.5 w-3.5" />
                高级筛选
              </Button>
            </div>
          </div>

          {advancedFiltersOpen && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-background px-3 py-2">
              <span className="mr-1 text-xs font-medium text-muted-foreground">来源</span>
              <FilterButton active={sourceFilter === 'all'} onClick={() => updateSourceFilter('all')}>
                全部来源
              </FilterButton>
              <FilterButton active={sourceFilter === 'builtin'} onClick={() => updateSourceFilter('builtin')}>
                系统内置
              </FilterButton>
              <FilterButton active={sourceFilter === 'custom'} onClick={() => updateSourceFilter('custom')}>
                自定义
              </FilterButton>
            </div>
          )}

          {selectedRowIds.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
              <span>已选择 {selectedRowIds.size} 个评测集</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedRowIds(new Set())} className="h-7 px-2 text-xs text-primary hover:bg-primary/10">
                清空选择
              </Button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1160px] text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-medium text-muted-foreground">
                <th className="w-11 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleVisibleRows}
                    className="h-4 w-4 rounded border-border bg-background"
                    aria-label="选择当前页评测集"
                  />
                </th>
                <th className="px-4 py-3">名称</th>
                <th className="px-4 py-3">描述</th>
                <th className="px-4 py-3 text-center">用例数</th>
                <th className="px-4 py-3 text-center">最近评测通过率</th>
                <th className="px-4 py-3 text-center">用户反馈通过率</th>
                <th className="px-4 py-3">负责人</th>
                <th className="px-4 py-3">最后修改时间</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedVisibleEvalSets.map((evalSet) => {
                const summary = runSummaryBySet.get(evalSet.id);
                const latestPassRate = summary?.latestPassRate ?? null;
                const feedbackPassRate = summary?.feedbackPassRate ?? null;
                const isActive = evalSet.id === selectedEvalSet.id;
                const owner = summary?.owner ?? '-';

                return (
                  <tr
                    key={evalSet.id}
                    className="border-b border-border/30 transition-colors last:border-b-0 hover:bg-muted/25"
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedRowIds.has(evalSet.id)}
                        onChange={() => toggleRow(evalSet.id)}
                        className="h-4 w-4 rounded border-border bg-background"
                        aria-label={`勾选 ${evalSet.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onEvalSetSelect(evalSet.id)}
                        className="flex min-w-0 items-center gap-2 text-left"
                      >
                        <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                        <span className="max-w-[260px] truncate font-semibold text-primary">
                          {evalSet.name}
                        </span>
                      </button>
                    </td>
                    <td className="max-w-[260px] px-4 py-3 text-muted-foreground">
                      <span className="line-clamp-1">{evalSet.description || '-'}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant="secondary" className="h-5 rounded px-2 text-[11px] text-primary">
                        {evalSet.caseIds.length}
                      </Badge>
                    </td>
                    <td className={cn('px-4 py-3 text-center text-xs font-semibold tabular-nums', latestPassRate === null ? 'text-muted-foreground' : passRateClass(latestPassRate))}>
                      {latestPassRate === null ? '-' : `${latestPassRate}%`}
                    </td>
                    <td className={cn('px-4 py-3 text-center text-xs font-semibold tabular-nums', feedbackPassRate === null ? 'text-muted-foreground' : passRateClass(feedbackPassRate))}>
                      {feedbackPassRate === null ? '-' : `${feedbackPassRate}%`}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {owner === '-' ? '-' : (
                        <span className="inline-flex items-center gap-1">
                          <UserRound className="h-3.5 w-3.5" />
                          {owner}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {summary?.latestRun ? formatRelativeTime(summary.latestRun.createdAt) : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onRunEvalSet(evalSet.id)}
                          disabled={isStarting}
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          aria-label={`运行 ${evalSet.name}`}
                        >
                          {isStarting && isActive ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!pagedVisibleEvalSets.length && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    没有匹配的评测集。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <EvalPagination
          page={currentPage}
          pageSize={evalSetPageSize}
          totalItems={visibleEvalSets.length}
          onPageChange={(page) => onEvalSetPageChange(() => page)}
          onPageSizeChange={onEvalSetPageSizeChange}
        />
      </section>
      <CreateEvalSetSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        cases={cases}
        onCreateEvalSet={onCreateEvalSet}
      />
    </div>
  );
}
