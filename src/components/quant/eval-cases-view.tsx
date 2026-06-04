import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  ClipboardList,
  Clock3,
  FileText,
  Loader2,
  Play,
  Plus,
  Search,
  Tags,
  TriangleAlert,
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
import { EvalPagination, EvalSelect, statusPill } from '@/components/quant/eval-console-primitives';
import type { QuantEvalCase, QuantEvalResult, QuantEvalRun } from '@/lib/quant/evals';
import { cn } from '@/lib/utils';

type EvalCasesViewProps = {
  caseKeyword: string;
  selectedCaseIds: string[];
  totalCaseCount: number;
  filteredCases: QuantEvalCase[];
  selectedEvalSetCases: QuantEvalCase[];
  latestRun: QuantEvalRun | null;
  latestResultByCase: Map<string, QuantEvalResult>;
  isStarting: boolean;
  onCaseKeywordChange: (keyword: string) => void;
  onSelectedCaseIdsChange: (caseIds: string[]) => void;
  onRunSelection: () => void;
  onCreateCase: (payload: Record<string, unknown>) => Promise<void>;
  onRunCase: (caseId: string) => void;
};

type CaseStatusFilter = 'all' | 'passed' | 'failed' | 'not_run';

function MetricCard({
  icon,
  label,
  value,
  tone = 'blue',
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone?: 'blue' | 'emerald' | 'amber' | 'red';
}) {
  const toneClass = {
    blue: 'bg-blue-500/10 text-blue-500',
    emerald: 'bg-emerald-500/10 text-emerald-500',
    amber: 'bg-amber-500/10 text-amber-500',
    red: 'bg-red-500/10 text-red-500',
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

function FilterChip({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
        active
          ? 'border-primary/40 bg-primary/10 text-primary shadow-sm shadow-primary/5'
          : 'border-slate-200/80 bg-background text-muted-foreground hover:border-primary/25 hover:bg-primary/5 hover:text-primary dark:border-border/50',
      )}
    >
      {icon}
      {children}
    </button>
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
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function splitList(value: string) {
  return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
}

function CreateCaseSheet({
  open,
  onOpenChange,
  capabilityOptions,
  typeOptions,
  onCreateCase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capabilityOptions: string[];
  typeOptions: string[];
  onCreateCase: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [capabilityId, setCapabilityId] = useState(capabilityOptions[0] ?? 'asset_comparison');
  const [type, setType] = useState(typeOptions[0] ?? 'generated_project');
  const [expectedSymbols, setExpectedSymbols] = useState('');
  const [expectedTemplateId, setExpectedTemplateId] = useState('');
  const [expectedAssetType, setExpectedAssetType] = useState('');
  const [expectedDatasets, setExpectedDatasets] = useState('');
  const [expectedRawFiles, setExpectedRawFiles] = useState('');
  const [expectedFinalFields, setExpectedFinalFields] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCapabilityId((current) => current || capabilityOptions[0] || 'asset_comparison');
    setType((current) => current || typeOptions[0] || 'generated_project');
  }, [capabilityOptions, open, typeOptions]);

  const reset = () => {
    setId('');
    setName('');
    setQuestion('');
    setCapabilityId(capabilityOptions[0] ?? 'asset_comparison');
    setType(typeOptions[0] ?? 'generated_project');
    setExpectedSymbols('');
    setExpectedTemplateId('');
    setExpectedAssetType('');
    setExpectedDatasets('');
    setExpectedRawFiles('');
    setExpectedFinalFields('');
    setError(null);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[min(560px,calc(100vw-24px))] max-w-none flex-col gap-0 overflow-hidden border-l border-border bg-background p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border/40 bg-background/95 px-5 py-4 backdrop-blur-xl">
          <SheetTitle className="text-base">新增测试用例</SheetTitle>
          <SheetDescription className="text-xs">
            创建后会写入 benchmarks/quantpilot/cases.json，并立即出现在评测平台。
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex flex-1 flex-col overflow-hidden"
          onSubmit={async (event) => {
            event.preventDefault();
            setIsSaving(true);
            setError(null);
            try {
              await onCreateCase({
                id: id.trim() || undefined,
                name: name.trim(),
                question: question.trim(),
                capabilityId,
                type,
                expectedSymbols: splitList(expectedSymbols),
                expectedTemplateId: expectedTemplateId.trim() || undefined,
                expectedAssetType: expectedAssetType.trim() || undefined,
                expectedDatasets: splitList(expectedDatasets),
                expectedRawFiles: splitList(expectedRawFiles),
                expectedFinalFields: splitList(expectedFinalFields),
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
                <Label htmlFor="case-id">用例 ID</Label>
                <Input id="case-id" value={id} onChange={(event) => setId(event.target.value)} placeholder="留空自动生成" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="case-name">用例名称</Label>
                <Input id="case-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：沪深300趋势看板" required />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="case-question">用户 Query</Label>
              <Textarea id="case-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="输入用于评测的用户需求..." className="min-h-24" required />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>能力</Label>
                <EvalSelect
                  value={capabilityId}
                  onValueChange={setCapabilityId}
                  options={capabilityOptions.map((capability) => ({ value: capability, label: capability }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>类型</Label>
                <EvalSelect
                  value={type}
                  onValueChange={setType}
                  options={typeOptions.map((item) => ({ value: item, label: item }))}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="case-symbols">预期标的</Label>
                <Input id="case-symbols" value={expectedSymbols} onChange={(event) => setExpectedSymbols(event.target.value)} placeholder="600519, 000300" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="case-template">模板 ID</Label>
                <Input id="case-template" value={expectedTemplateId} onChange={(event) => setExpectedTemplateId(event.target.value)} placeholder="stock-selection" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="case-asset-type">资产类型</Label>
              <Input id="case-asset-type" value={expectedAssetType} onChange={(event) => setExpectedAssetType(event.target.value)} placeholder="stock / index / etf，可选" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="case-datasets">预期数据集</Label>
              <Textarea id="case-datasets" value={expectedDatasets} onChange={(event) => setExpectedDatasets(event.target.value)} placeholder="quote, kline, technical_indicators" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="case-raw-files">预期原始文件</Label>
              <Textarea id="case-raw-files" value={expectedRawFiles} onChange={(event) => setExpectedRawFiles(event.target.value)} placeholder="quote.json, kline-daily-qfq.json" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="case-final-fields">预期最终字段</Label>
              <Textarea id="case-final-fields" value={expectedFinalFields} onChange={(event) => setExpectedFinalFields(event.target.value)} placeholder="assets, comparison, selectionRanking" />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
              取消
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              创建用例
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function EvalCasesView({
  caseKeyword,
  selectedCaseIds,
  totalCaseCount,
  filteredCases,
  selectedEvalSetCases,
  latestRun,
  latestResultByCase,
  isStarting,
  onCaseKeywordChange,
  onSelectedCaseIdsChange,
  onRunSelection,
  onCreateCase,
  onRunCase,
}: EvalCasesViewProps) {
  const [typeFilter, setTypeFilter] = useState('all');
  const [capabilityFilter, setCapabilityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<CaseStatusFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [createOpen, setCreateOpen] = useState(false);
  const pageSelectRef = useRef<HTMLInputElement>(null);

  const typeOptions = useMemo(
    () => Array.from(new Set(selectedEvalSetCases.map((testCase) => testCase.typeLabel))),
    [selectedEvalSetCases],
  );
  const capabilityOptions = useMemo(
    () => Array.from(new Set(selectedEvalSetCases.map((testCase) => testCase.capabilityLabel))),
    [selectedEvalSetCases],
  );
  const createTypeOptions = useMemo(
    () => Array.from(new Set(selectedEvalSetCases.map((testCase) => testCase.type))),
    [selectedEvalSetCases],
  );
  const createCapabilityOptions = useMemo(
    () => Array.from(new Set(selectedEvalSetCases.map((testCase) => testCase.capabilityId))),
    [selectedEvalSetCases],
  );

  const getCaseResult = (testCase: QuantEvalCase) =>
    latestResultByCase.get(testCase.id) ?? latestResultByCase.get(testCase.name);
  const getCaseStatus = (testCase: QuantEvalCase): Exclude<CaseStatusFilter, 'all'> => {
    const result = getCaseResult(testCase);
    if (!result) return 'not_run';
    return result.passed ? 'passed' : 'failed';
  };

  const visibleCases = filteredCases.filter((testCase) => {
    if (typeFilter !== 'all' && testCase.typeLabel !== typeFilter) return false;
    if (capabilityFilter !== 'all' && testCase.capabilityLabel !== capabilityFilter) return false;
    if (statusFilter !== 'all' && getCaseStatus(testCase) !== statusFilter) return false;
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(visibleCases.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedCases = visibleCases.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedCaseIdSet = useMemo(() => new Set(selectedCaseIds), [selectedCaseIds]);
  const selectedCaseCount = selectedCaseIds.length;
  const pagedCaseIds = useMemo(() => pagedCases.map((testCase) => testCase.id), [pagedCases]);
  const allPagedCasesSelected = pagedCaseIds.length > 0 && pagedCaseIds.every((caseId) => selectedCaseIdSet.has(caseId));
  const somePagedCasesSelected = pagedCaseIds.some((caseId) => selectedCaseIdSet.has(caseId));

  const selectedSetResults = selectedEvalSetCases.map((testCase) => getCaseResult(testCase));
  const passedCount = selectedSetResults.filter((result) => result?.passed).length;
  const failedCount = selectedSetResults.filter((result) => result && !result.passed).length;
  const notRunCount = Math.max(0, selectedEvalSetCases.length - passedCount - failedCount);

  useEffect(() => {
    setPage(1);
  }, [caseKeyword, typeFilter, capabilityFilter, statusFilter, selectedEvalSetCases]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    if (pageSelectRef.current) {
      pageSelectRef.current.indeterminate = !allPagedCasesSelected && somePagedCasesSelected;
    }
  }, [allPagedCasesSelected, somePagedCasesSelected]);

  const toggleCaseSelection = (caseId: string) => {
    if (selectedCaseIdSet.has(caseId)) {
      onSelectedCaseIdsChange(selectedCaseIds.filter((selectedId) => selectedId !== caseId));
      return;
    }
    onSelectedCaseIdsChange([...selectedCaseIds, caseId]);
  };

  const togglePagedSelection = () => {
    if (!pagedCaseIds.length) return;
    if (allPagedCasesSelected) {
      const pagedIdSet = new Set(pagedCaseIds);
      onSelectedCaseIdsChange(selectedCaseIds.filter((caseId) => !pagedIdSet.has(caseId)));
      return;
    }
    const next = new Set(selectedCaseIds);
    pagedCaseIds.forEach((caseId) => next.add(caseId));
    onSelectedCaseIdsChange(Array.from(next));
  };

  const statusFilters: Array<{ id: CaseStatusFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'passed', label: '通过' },
    { id: 'failed', label: '失败' },
    { id: 'not_run', label: '未运行' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-xl font-bold tracking-normal text-foreground">测试用例</h2>
          <Badge variant="secondary" className="h-6 rounded-md px-2 text-xs">
            共 {totalCaseCount} 个
          </Badge>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<ClipboardList className="h-4 w-4" />} label="全部用例" value={selectedEvalSetCases.length} />
        <MetricCard icon={<CheckCircle2 className="h-4 w-4" />} label="最近通过" value={passedCount} tone="emerald" />
        <MetricCard icon={<Clock3 className="h-4 w-4" />} label="未运行" value={notRunCount} tone="amber" />
        <MetricCard icon={<TriangleAlert className="h-4 w-4" />} label="需关注" value={failedCount} tone="red" />
      </section>

      <section className="rounded-lg border border-border/50 bg-card shadow-sm">
        <div className="border-b border-slate-200/70 p-4 dark:border-border/40">
          <div
            data-eval-cases-toolbar
            className="rounded-2xl border border-slate-200/80 bg-background/80 p-3 shadow-sm dark:border-border/40 dark:bg-card/70"
          >
            <div className="flex flex-col items-stretch gap-3 lg:grid lg:grid-cols-[minmax(220px,300px)_minmax(0,1fr)_auto] lg:items-center">
              <div data-eval-cases-toolbar-search className="relative min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={caseKeyword}
                  onChange={(event) => onCaseKeywordChange(event.target.value)}
                  placeholder="搜索用例 ID、名称、用户 Query..."
                  className="h-11 rounded-xl border-slate-200/80 bg-card/70 pl-9 text-sm shadow-none dark:border-border/50 dark:bg-background"
                />
              </div>
              <div data-eval-cases-toolbar-filters className="flex min-w-0 flex-wrap items-center justify-start gap-2">
                <EvalSelect
                  value={typeFilter}
                  onValueChange={setTypeFilter}
                  options={[
                    { value: 'all', label: '全部类型' },
                    ...typeOptions.map((type) => ({ value: type, label: type })),
                  ]}
                  className="h-9 w-[120px] rounded-full border-slate-200/80 shadow-none dark:border-border/50"
                  contentClassName="min-w-[160px]"
                />
                <EvalSelect
                  value={capabilityFilter}
                  onValueChange={setCapabilityFilter}
                  options={[
                    { value: 'all', label: '全部能力' },
                    ...capabilityOptions.map((capability) => ({ value: capability, label: capability })),
                  ]}
                  className="h-9 w-[120px] rounded-full border-slate-200/80 shadow-none dark:border-border/50"
                  contentClassName="min-w-[170px]"
                />
                {statusFilters.map((filter) => {
                  const isActive = statusFilter === filter.id;
                  const icon = filter.id === 'passed'
                    ? <CheckCircle2 className="h-3.5 w-3.5" />
                    : filter.id === 'failed'
                      ? <TriangleAlert className="h-3.5 w-3.5" />
                      : filter.id === 'not_run'
                        ? <Clock3 className="h-3.5 w-3.5" />
                        : <ClipboardList className="h-3.5 w-3.5" />;
                  return (
                    <FilterChip
                      key={filter.id}
                      active={isActive}
                      icon={icon}
                      onClick={() => setStatusFilter(filter.id)}
                    >
                      {filter.label}
                    </FilterChip>
                  );
                })}
              </div>
              <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center lg:justify-self-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRunSelection}
                  disabled={isStarting || selectedCaseCount === 0}
                  className="h-9 gap-1.5 rounded-full border-slate-200/80 px-4 text-xs shadow-none dark:border-border/50"
                >
                  {isStarting && selectedCaseCount > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  运行已选
                  {selectedCaseCount > 0 && (
                    <Badge variant="secondary" className="ml-0.5 h-5 rounded px-1.5 text-[10px]">
                      {selectedCaseCount}
                    </Badge>
                  )}
                </Button>
                <Button
                  size="sm"
                  onClick={() => setCreateOpen(true)}
                  className="h-9 gap-1.5 rounded-full px-4 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  新增用例
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 text-left text-xs font-medium text-muted-foreground">
                <th className="w-11 px-4 py-3">
                  <input
                    ref={pageSelectRef}
                    type="checkbox"
                    checked={allPagedCasesSelected}
                    onChange={togglePagedSelection}
                    disabled={!pagedCaseIds.length}
                    className="h-4 w-4 rounded border-border bg-background"
                    aria-label="选择当前页测试用例"
                  />
                </th>
                <th className="px-4 py-3">用例名称</th>
                <th className="px-4 py-3">用户 Query</th>
                <th className="px-4 py-3">标签</th>
                <th className="px-4 py-3 text-center">预期标的</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">所属能力</th>
                <th className="px-4 py-3">最近运行</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedCases.map((testCase) => {
                const result = getCaseResult(testCase);
                const isSelected = selectedCaseIdSet.has(testCase.id);

                return (
                  <tr
                    key={testCase.id}
                    className={cn(
                      'border-b border-border/30 transition-colors last:border-b-0 hover:bg-muted/25',
                      isSelected && 'bg-primary/5',
                    )}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleCaseSelection(testCase.id)}
                        className="h-4 w-4 rounded border-border bg-background"
                        aria-label={`选择 ${testCase.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => toggleCaseSelection(testCase.id)}
                        className="flex min-w-0 items-center gap-2 text-left"
                      >
                        <FileText className="h-4 w-4 shrink-0 text-primary" />
                        <span className={cn('max-w-[260px] truncate font-semibold', isSelected ? 'text-primary' : 'text-foreground')}>
                          {testCase.name}
                        </span>
                      </button>
                      <p className="mt-0.5 max-w-[260px] truncate font-mono text-[11px] text-muted-foreground">{testCase.id}</p>
                    </td>
                    <td className="max-w-[290px] px-4 py-3 text-muted-foreground">
                      <span className="line-clamp-1">{testCase.question}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-[230px] flex-wrap gap-1">
                        <Badge variant="outline" className="whitespace-nowrap border-blue-500/20 bg-blue-500/5 text-[10px] text-primary">
                          {testCase.typeLabel}
                        </Badge>
                        {testCase.tags.slice(0, 1).map((tag) => (
                          <Badge key={tag} variant="outline" className="max-w-[132px] whitespace-nowrap border-border/50 text-[10px] text-muted-foreground">
                            <span className="truncate">{tag}</span>
                          </Badge>
                        ))}
                        {testCase.tags.length > 1 && (
                          <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">
                            +{testCase.tags.length - 1}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-1 font-mono text-xs text-primary">
                        <Tags className="h-3 w-3" />
                        {testCase.expectedSymbols.slice(0, 2).join(', ') || '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3">{statusPill(result)}</td>
                    <td className="px-4 py-3">
                      <Badge className="min-w-[76px] justify-center whitespace-nowrap border-primary/20 bg-primary/10 px-2.5 text-xs text-primary hover:bg-primary/10">
                        {testCase.capabilityLabel}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {result ? formatRelativeTime(latestRun?.createdAt) : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {latestRun && result && (
                          <Button variant="ghost" size="icon" asChild className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label="查看结果">
                            <Link href={`/eval-platform/runs/${latestRun.id}#case-${result.id}`}>
                              <FileText className="h-3.5 w-3.5" />
                            </Link>
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={() => onRunCase(testCase.id)} disabled={isStarting} className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label={`运行 ${testCase.name}`}>
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!pagedCases.length && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    没有匹配的测试用例。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <EvalPagination
          page={currentPage}
          pageSize={pageSize}
          totalItems={visibleCases.length}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize);
            setPage(1);
          }}
        />
      </section>
      <CreateCaseSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        capabilityOptions={createCapabilityOptions.length ? createCapabilityOptions : ['asset_comparison']}
        typeOptions={createTypeOptions.length ? createTypeOptions : ['generated_project']}
        onCreateCase={onCreateCase}
      />
    </div>
  );
}
