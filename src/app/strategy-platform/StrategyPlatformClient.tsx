"use client";

import { Fragment, type FormEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  CircleStop,
  GitBranch,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
  Search,
  ShieldCheck,
  SkipForward,
  SquareStack,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListPlus,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as Dialog from "@radix-ui/react-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/PageHeader";
import { SubNav } from "@/components/layout/SubNav";
import { formatCompactDate as formatDate } from "@/components/quant/console-primitives";
import { cn } from "@/lib/utils";
import type {
  StrategyAutoFillIngestionStartResult,
  StrategyCatalogItem,
  StrategyDashboardData,
  StrategyDividendEvent,
  StrategyFactorCatalogItem,
  StrategyFactorDefinition,
  StrategyFoundationComponent,
  StrategyHistoryIngestionResult,
  StrategyIngestionJob,
  StrategyLocalKlineBar,
  StrategyLocalKlineResponse,
  StrategyRealtimeQuote,
  StrategySectorCapitalFlowDetail,
  StrategySectorCapitalFlowItem,
  StrategySectorCapitalFlowMarketSummary,
  StrategyUniverse,
  StrategyUniverseMember,
  StrategyUniverseMembersPage,
} from "@/lib/quant/strategies";
import { FinancialKnowledgeView } from "./FinancialKnowledgeView";
import { UniverseView } from "./UniverseView";
import { FactorCatalogView } from "./FactorCatalogView";
import { FoundationView } from "./FoundationView";
import { SectorCapitalFlowView } from "./SectorCapitalFlowView";
import {
  type StrategyView,
  type IngestionRangeMode,
  API_BASE,
  INGESTION_BATCH_SIZE,
  INGESTION_LOG_LIMIT,
  statusLabel,
  statusClass,
  scanStatusClass,
  scanStatusLabel,
  riskClass,
  strategyKindLabel,
  strategyKindClass,
  ruleStatusClass,
  ruleStatusLabel,
  previewRules,
  dataStatusText,
  formatMetric,
  formatDataDate,
  formatDateTime,
  formatIntradayTime,
  todayInputValue,
  addDaysInputValue,
  formatDuration,
  finiteNumber,
  formatNumberValue,
  formatSignedNumberValue,
  formatLargeValue,
  formatSignedPercent,
  formatPercentValue,
  signedToneClass,
  trendLabel,
  trendClass,
  liquidityLabel,
  liquiditySubLabel,
  valuationSummary,
  isEtfUniverse,
  jobStatusLabel,
  jobStatusClass,
  ingestionControlLabel,
  ingestionRangeLabel,
  findLatestUniverseBatchJob,
  findLatestAutoFillJob,
  findLatestRunningAutoFillChildJob,
  ingestionControlJobId,
  numberFromUnknown,
  stringFromUnknown,
  isStaleRunningIngestionJob,
  ingestionProgress,
  ingestionBatchRangeLabel,
  ingestionSymbolPreview,
  ingestionErrorPreview,
  SUB_NAV_ITEMS
} from "./strategy-platform-helpers";

type Props = { initialData: StrategyDashboardData };
function StrategySelector({
  templates,
  selectedId,
  keyword,
  onKeywordChange,
  onSelect,
}: {
  templates: StrategyCatalogItem[];
  selectedId: string;
  keyword: string;
  onKeywordChange: (v: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder="搜索策略、参数、端点..."
            className="h-9 border-slate-200 bg-white pl-9"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors",
              selectedId === t.id
                ? "border-blue-200 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
            )}
          >
            <span className={cn("text-sm font-medium", selectedId === t.id ? "text-blue-700" : "text-slate-700")}>
              {t.name}
            </span>
            <span className={cn("rounded-full border px-1.5 py-0 text-[10px] font-medium", statusClass(t.status))}>
              {statusLabel(t.status)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Strategy Row (Table List) ──────────────────────────────────
function StrategyRow({ strategy, onClick }: { strategy: StrategyCatalogItem; onClick: () => void }) {
  const paramPreview = strategy.parameterSchema
    .slice(0, 3)
    .map((p) => `${p.label}=${p.value}${p.unit ?? ""}`)
    .join("  ");
  const rules = previewRules(strategy);
  const missingCount = strategy.dataReadiness?.missing.length ?? 0;

  return (
    <tr
      onClick={onClick}
      className="group cursor-pointer bg-white shadow-sm transition-colors hover:bg-blue-50/40"
    >
      <td className="w-1 rounded-l-lg border-y border-l border-slate-100 py-3.5 pl-4 pr-0">
        <div
          className={cn(
            "h-9 w-1 rounded-full",
            strategy.status === "ready"
              ? "bg-emerald-400"
              : strategy.status === "research"
                ? "bg-blue-400"
                : "bg-amber-400"
          )}
        />
      </td>
      <td className="border-y border-slate-100 px-4 py-3.5 min-w-[240px]">
        <div className="flex items-center gap-2">
          <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", strategyKindClass(strategy.kind))}>
            {strategyKindLabel(strategy.kind)}
          </span>
          <p className="text-sm font-semibold text-slate-900 transition-colors group-hover:text-blue-700">
            {strategy.name}
          </p>
        </div>
        <p className="mt-1 text-[11px] text-slate-400">{strategy.family} · {strategy.timeframe}</p>
      </td>
      <td className="min-w-[360px] border-y border-slate-100 px-3 py-3.5">
        <div className="flex flex-wrap gap-1.5">
          {rules.map((rule) => (
            <span key={rule.label} className={cn("rounded-md border px-2 py-1 text-[11px] font-medium", ruleStatusClass(rule.dataStatus))}>
              {rule.label}
            </span>
          ))}
        </div>
        <p className="mt-1 line-clamp-1 text-xs text-slate-500">{strategy.description}</p>
      </td>
      <td className="border-y border-slate-100 px-3 py-3.5">
        <span
          className={cn(
            "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium",
            missingCount > 0 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"
          )}
        >
          {dataStatusText(strategy)}
        </span>
        <p className="mt-1 text-[11px] text-slate-400">{strategy.readiness.label}</p>
      </td>
      <td className="hidden border-y border-slate-100 px-3 py-3.5 lg:table-cell">
        <span className="block max-w-[280px] truncate font-mono text-xs text-slate-500">
          {paramPreview || "-"}
        </span>
        {strategy.rankingRules?.length ? (
          <span className="mt-1 block truncate text-[11px] text-slate-400">{strategy.rankingRules[0]}</span>
        ) : null}
      </td>
      <td className="rounded-r-lg border-y border-r border-slate-100 px-4 py-3.5">
        <ChevronDown className="h-4 w-4 -rotate-90 text-slate-300 transition-all group-hover:translate-x-0.5 group-hover:text-blue-400" />
      </td>
    </tr>
  );
}

// ─── Main Page ─────────────────────────────────────────────────
export default function StrategyPlatformClient({ initialData }: Props) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [selectedId, setSelectedId] = useState(initialData.templates[0]?.id ?? "");
  const [view, setView] = useState<StrategyView>("universe");
  const [keyword, setKeyword] = useState("");
  const [symbol, setSymbol] = useState(initialData.templates[0]?.defaultSymbols[0] ?? "");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [runningScanId, setRunningScanId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [dialogStrategy, setDialogStrategy] = useState<StrategyCatalogItem | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const filteredTemplates = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    return data.templates.filter((t) => {
      if (!lower) return true;
      return [
        t.id,
        t.name,
        t.family,
        strategyKindLabel(t.kind),
        t.description,
        t.capabilityId,
        ...t.defaultSymbols,
        ...t.dataDependencies,
        ...t.riskControls,
        ...(t.selectionRules ?? []).flatMap((rule) => [rule.label, rule.description]),
        ...(t.entryRules ?? []).flatMap((rule) => [rule.label, rule.description]),
        ...(t.exitRules ?? []).flatMap((rule) => [rule.label, rule.description]),
        ...(t.rankingRules ?? []),
      ]
        .join(" ").toLowerCase().includes(lower);
    });
  }, [data.templates, keyword]);

  const families = useMemo(() => Array.from(new Set(data.templates.map((t) => t.family))), [data.templates]);
  const [familyFilter, setFamilyFilter] = useState<string | null>(null);
  const displayTemplates = familyFilter ? filteredTemplates.filter((t) => t.family === familyFilter) : filteredTemplates;

  const selectedTemplate =
    data.templates.find((t) => t.id === selectedId) ?? filteredTemplates[0] ?? data.templates[0] ?? null;

  const comparisonResults = (selectedTemplate?.latestScanRun?.results ?? [])
    .filter((r) => r.status === "success")
    .slice()
    .sort((a, b) => (b.metrics.totalReturnPct ?? -Infinity) - (a.metrics.totalReturnPct ?? -Infinity));

  const refresh = async () => {
    setIsRefreshing(true);
    setToast(null);
    try {
      const r = await fetch(`${API_BASE}/api/quant/strategies`, { cache: "no-store" });
      const payload = await r.json();
      if (!r.ok || !payload.success) throw new Error(payload.error ?? "刷新失败");
      setData(payload.data);
      if (!payload.data.templates.some((t: StrategyCatalogItem) => t.id === selectedId)) {
        setSelectedId(payload.data.templates[0]?.id ?? "");
      }
    } catch (error) {
      setToast({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRefreshing(false);
    }
  };

  const createStrategyWorkspace = async () => {
    const strategy = dialogStrategy || selectedTemplate;
    if (!strategy || isCreating) return;
    setIsCreating(true);
    setToast(null);
    try {
      const pr = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: strategy.id, symbol }),
      });
      const pp = await pr.json();
      if (!pr.ok || !pp.success) throw new Error(pp.error ?? "生成策略提示失败");
      const projectId = `project-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      const { name, prompt, capabilityId } = pp.data as { name: string; prompt: string; capabilityId: string };
      const cr = await fetch(`${API_BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, name, initialPrompt: prompt, quantCapabilityId: capabilityId }),
      });
      const cp = await cr.json();
      if (!cr.ok || !cp.success) throw new Error(cp.error ?? "创建策略工作空间失败");
      const createdId = cp.data?.id ?? projectId;
      await fetch(`${API_BASE}/api/chat/${createdId}/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: prompt, isInitialPrompt: true, quantCapabilityId: capabilityId }),
      }).catch(() => null);
      router.push(`/${createdId}/chat`);
    } catch (error) {
      setToast({ type: "error", message: error instanceof Error ? error.message : String(error) });
      setIsCreating(false);
    }
  };

  const runScan = async (scanId: string) => {
    if (!selectedTemplate || runningScanId) return;
    setRunningScanId(scanId);
    setToast(null);
    try {
      const r = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-scan", templateId: selectedTemplate.id, scanId, symbol }),
      });
      const payload = await r.json();
      if (!r.ok || !payload.success) throw new Error(payload.error ?? "参数扫描失败");
      setToast({ type: "success", message: `扫描任务已加入队列：${payload.data.id}` });
      await refresh();
      setView("scans");
    } catch (error) {
      setToast({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunningScanId(null);
    }
  };

  const addUniverseMember = async (universeId: string, query: string) => {
    if (isAddingMember) return;
    setIsAddingMember(true);
    setToast(null);
    try {
      const r = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add-universe-member",
          universeId,
          query,
          syncHistory: false,
        }),
      });
      const payload = await r.json();
      if (!r.ok || !payload.success) throw new Error(payload.error ?? "加入股票池失败");
      await refresh();
      const member = payload.data?.member;
      setToast({
        type: "success",
        message: `${member?.name ?? member?.symbol ?? query} 已加入股票池`,
      });
    } catch (error) {
      setToast({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsAddingMember(false);
    }
  };

  const switchView = (v: string) => setView(v as StrategyView);
  const selectTemplate = (id: string) => {
    setSelectedId(id);
    const t = data.templates.find((tmpl) => tmpl.id === id);
    if (t) setSymbol(t.defaultSymbols[0] ?? "");
  };

  return (
    <div className="platform-shell">
      <PageHeader
        title="策略平台"
        badge={<Badge variant="outline" className="border-primary/15 bg-primary/5 text-primary">{data.summary.templates} 个策略模板</Badge>}
        subtitle={`股票池、策略目录、因子目录、板块资金和金融知识 · 生成于 ${formatDate(data.generatedAt)}`}
      />

      <SubNav
        items={SUB_NAV_ITEMS}
        activeId={view}
        onChange={switchView}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
              <RefreshCcw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
              刷新
            </Button>
          </div>
        }
      />

      <main className="platform-content mx-auto w-full max-w-[1900px] space-y-5 px-3 py-6 lg:px-4">
        {toast && (
          <div className={cn("rounded-md border px-4 py-3 text-sm shadow-sm",
            toast.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
          )}>{toast.message}</div>
        )}
        {/* ── Universe Tab ─────────────────────────────── */}
        {view === "universe" && (
          <UniverseView data={data} isAdding={isAddingMember} onAdd={addUniverseMember} />
        )}

        {/* ── Catalog Tab: Strategy Plan Library ────────── */}
        {view === "catalog" && (
          <>
            {/* Search + family filter (merged) */}
            <div className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative min-w-[260px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索选股条件、买入卖出、DDE、均线..." className="h-9 rounded-lg border-slate-200/80 bg-white pl-9 shadow-sm" />
                </div>
                <div className="flex items-center gap-0.5 rounded-lg border border-slate-200/80 bg-slate-50 p-0.5 shadow-sm">
                  <button type="button" onClick={() => setFamilyFilter(null)}
                    className={cn(
                      "relative rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150",
                      !familyFilter
                        ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/50"
                        : "text-slate-500 hover:text-slate-700"
                    )}>
                    全部<span className="ml-1 text-slate-400 tabular-nums">{data.templates.length}</span>
                  </button>
                  {families.map((fam) => {
                    const count = data.templates.filter((t) => t.family === fam).length;
                    return (
                      <button key={fam} type="button" onClick={() => setFamilyFilter(fam)}
                        className={cn(
                          "relative rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150",
                          familyFilter === fam
                            ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/50"
                            : "text-slate-500 hover:text-slate-700"
                        )}>
                        {fam}<span className="ml-1 text-slate-400 tabular-nums">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Filter active indicator */}
              {familyFilter && (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <div className="h-1 w-1 rounded-full bg-blue-400" />
                  已筛选 <span className="font-semibold text-slate-700">{familyFilter}</span>
                  <button type="button" onClick={() => setFamilyFilter(null)} className="ml-1 text-slate-400 hover:text-slate-600 underline underline-offset-2">清除</button>
                  <span className="text-slate-300">·</span>
                  <span className="tabular-nums">{displayTemplates.length} 个策略方案</span>
                </div>
              )}
            </div>

            {/* Strategy table */}
            {displayTemplates.length === 0 ? (
              <EmptyState title={keyword || familyFilter ? "没有匹配的策略方案" : "暂无策略方案"} description={keyword ? "尝试其他关键词" : "请运行策略扫描生成模板数据"} className="border-0" />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200/80 bg-slate-50/70 p-2 shadow-sm">
                <table className="w-full min-w-[1120px] border-separate border-spacing-y-1.5 text-left">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="w-1 rounded-l-lg bg-slate-50 py-2.5 pl-4 pr-0 font-medium" />
                      <th className="bg-slate-50 px-4 py-2.5 font-medium">策略方案</th>
                      <th className="bg-slate-50 px-3 py-2.5 font-medium">核心逻辑</th>
                      <th className="bg-slate-50 px-3 py-2.5 font-medium">数据状态</th>
                      <th className="hidden bg-slate-50 px-3 py-2.5 font-medium lg:table-cell">参数口径</th>
                      <th className="rounded-r-lg bg-slate-50 px-4 py-2.5 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {displayTemplates.map((t) => (
                      <StrategyRow
                        key={t.id}
                        strategy={t}
                        onClick={() => {
                          setDialogStrategy(t);
                          setSymbol(t.defaultSymbols[0] ?? "");
                          setDialogOpen(true);
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Strategy Detail Dialog */}
            <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
                <Dialog.Content className="fixed left-[50%] top-[50%] z-50 max-h-[85vh] w-[96vw] max-w-[680px] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
                  {dialogStrategy && (
                    <div className="flex max-h-[85vh] flex-col">
                      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
                        <div>
                          <Dialog.Title className="text-lg font-bold text-slate-900">{dialogStrategy.name}</Dialog.Title>
                          <Dialog.Description className="mt-1 text-sm text-slate-500">
                            {dialogStrategy.family} · {dialogStrategy.timeframe} · {dialogStrategy.readiness.summary}
                          </Dialog.Description>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", statusClass(dialogStrategy.status))}>{statusLabel(dialogStrategy.status)}</span>
                          <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", riskClass(dialogStrategy.readiness.riskLevel))}>{dialogStrategy.readiness.score}分</span>
                          <Dialog.Close className="ml-2 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
                            <X className="h-5 w-5" />
                          </Dialog.Close>
                        </div>
                      </div>

                      <div className="flex-1 space-y-6 overflow-y-auto p-6">
                        <p className="text-sm leading-6 text-slate-600">{dialogStrategy.description}</p>

                        {dialogStrategy.selectionRules?.length ? (
                          <section>
                            <h4 className="mb-3 text-sm font-semibold text-slate-900">选股条件</h4>
                            <div className="grid gap-2 sm:grid-cols-2">
                              {dialogStrategy.selectionRules.map((rule) => (
                                <div key={rule.label} className="rounded-lg border border-slate-200 bg-white p-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-semibold text-slate-900">{rule.label}</p>
                                    <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", ruleStatusClass(rule.dataStatus))}>
                                      {ruleStatusLabel(rule.dataStatus)}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-xs leading-5 text-slate-500">{rule.description}</p>
                                </div>
                              ))}
                            </div>
                          </section>
                        ) : null}

                        {dialogStrategy.entryRules?.length || dialogStrategy.exitRules?.length ? (
                          <section>
                            <h4 className="mb-3 text-sm font-semibold text-slate-900">买入与卖出价格计划</h4>
                            <div className="grid gap-3 md:grid-cols-2">
                              {dialogStrategy.entryRules?.length ? (
                                <div className="rounded-lg border border-slate-200">
                                  <div className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-900">买入/成本控制</div>
                                  <div className="divide-y divide-slate-100">
                                    {dialogStrategy.entryRules.map((rule) => (
                                      <div key={rule.label} className="px-4 py-3">
                                        <div className="flex items-center justify-between gap-2">
                                          <p className="text-sm font-medium text-slate-800">{rule.label}</p>
                                          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", ruleStatusClass(rule.dataStatus))}>
                                            {ruleStatusLabel(rule.dataStatus)}
                                          </span>
                                        </div>
                                        <p className="mt-1 text-xs leading-5 text-slate-500">{rule.description}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                              {dialogStrategy.exitRules?.length ? (
                                <div className="rounded-lg border border-slate-200">
                                  <div className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-900">卖出/风控退出</div>
                                  <div className="divide-y divide-slate-100">
                                    {dialogStrategy.exitRules.map((rule) => (
                                      <div key={rule.label} className="px-4 py-3">
                                        <div className="flex items-center justify-between gap-2">
                                          <p className="text-sm font-medium text-slate-800">{rule.label}</p>
                                          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", ruleStatusClass(rule.dataStatus))}>
                                            {ruleStatusLabel(rule.dataStatus)}
                                          </span>
                                        </div>
                                        <p className="mt-1 text-xs leading-5 text-slate-500">{rule.description}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </section>
                        ) : null}

                        {dialogStrategy.rankingRules?.length ? (
                          <section>
                            <h4 className="mb-2 text-sm font-semibold text-slate-900">排序与输出</h4>
                            <div className="flex flex-wrap gap-2">
                              {dialogStrategy.rankingRules.map((rule) => (
                                <span key={rule} className="rounded-md border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700">
                                  {rule}
                                </span>
                              ))}
                            </div>
                          </section>
                        ) : null}

                        {dialogStrategy.dataReadiness ? (
                          <section>
                            <h4 className="mb-3 text-sm font-semibold text-slate-900">数据可用性</h4>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-4">
                                <p className="mb-2 text-xs font-semibold text-emerald-700">已具备</p>
                                <div className="space-y-1 text-xs leading-5 text-emerald-800">
                                  {dialogStrategy.dataReadiness.ready.map((item) => <p key={item}>{item}</p>)}
                                </div>
                              </div>
                              <div className="rounded-lg border border-amber-100 bg-amber-50/70 p-4">
                                <p className="mb-2 text-xs font-semibold text-amber-700">待补齐</p>
                                <div className="space-y-1 text-xs leading-5 text-amber-800">
                                  {dialogStrategy.dataReadiness.missing.length
                                    ? dialogStrategy.dataReadiness.missing.map((item) => <p key={item}>{item}</p>)
                                    : <p>暂无关键缺口</p>}
                                </div>
                              </div>
                            </div>
                            {dialogStrategy.dataReadiness.notes.length ? (
                              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
                                {dialogStrategy.dataReadiness.notes.map((item) => <p key={item}>{item}</p>)}
                              </div>
                            ) : null}
                          </section>
                        ) : null}

                        <section>
                          <h4 className="mb-3 text-sm font-semibold text-slate-900">参数配置</h4>
                          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                            {dialogStrategy.parameterSchema.map((p) => (
                              <div key={p.key} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
                                <span className="shrink-0 font-medium text-slate-700">{p.label}</span>
                                <div className="text-right">
                                  <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-900">{p.value}{p.unit ?? ""}</span>
                                  <p className="mt-0.5 text-xs text-slate-400">{p.description}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </section>

                        <section>
                          <h4 className="mb-2 text-sm font-semibold text-slate-900">默认标的</h4>
                          <div className="flex flex-wrap gap-2">
                            {dialogStrategy.defaultSymbols.map((sym) => (
                              <span key={sym} className="rounded-md bg-slate-100 px-2.5 py-1.5 font-mono text-xs font-medium text-slate-700">{sym}</span>
                            ))}
                          </div>
                        </section>

                        <div className="grid gap-6 sm:grid-cols-2">
                          <section>
                            <h4 className="mb-2 text-sm font-semibold text-slate-900">评估指标</h4>
                            <div className="flex flex-wrap gap-1.5">
                              {dialogStrategy.evaluationMetrics.map((m) => (
                                <span key={m} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700">{m}</span>
                              ))}
                            </div>
                          </section>
                          <section>
                            <h4 className="mb-2 text-sm font-semibold text-slate-900">数据依赖</h4>
                            <div className="space-y-1">
                              {dialogStrategy.dataDependencies.map((ep) => (
                                <code key={ep} className="block truncate rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">{ep}</code>
                              ))}
                            </div>
                          </section>
                        </div>

                        <section>
                          <h4 className="mb-2 text-sm font-semibold text-slate-900">护栏与限制</h4>
                          <div className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm">
                            {dialogStrategy.riskControls.map((item) => (
                              <div key={item} className="flex gap-2 text-slate-700">
                                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                                <span>{item}</span>
                              </div>
                            ))}
                            {dialogStrategy.limitations.map((item) => (
                              <div key={item} className="rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-amber-800">{item}</div>
                            ))}
                          </div>
                        </section>

                        {dialogStrategy.backtestArchives.length > 0 && (
                          <section>
                            <h4 className="mb-3 text-sm font-semibold text-slate-900">回测归档</h4>
                            <div className="grid gap-3 sm:grid-cols-2">
                              {dialogStrategy.backtestArchives.map((a) => (
                                <div key={a.id} className="rounded-lg border border-slate-200 p-4">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-semibold text-slate-900">{a.title}</p>
                                    <Badge variant="outline" className="text-[10px]">{a.status}</Badge>
                                  </div>
                                  <p className="mt-1 text-xs text-slate-500">{a.symbol} · {a.period}</p>
                                  <div className="mt-3 grid grid-cols-2 gap-3">
                                    <div className="rounded-md bg-slate-50 px-3 py-2">
                                      <p className="text-[11px] text-slate-400">累计收益</p>
                                      <p className={cn("mt-0.5 text-lg font-bold tabular-nums", parseFloat(String(a.metrics.totalReturnPct ?? 0)) >= 0 ? "text-red-600" : "text-emerald-600")}>{a.metrics.totalReturnPct ?? "-"}%</p>
                                    </div>
                                    <div className="rounded-md bg-slate-50 px-3 py-2">
                                      <p className="text-[11px] text-slate-400">最大回撤</p>
                                      <p className="mt-0.5 text-lg font-bold tabular-nums text-emerald-600">{a.metrics.maxDrawdownPct ?? "-"}%</p>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </section>
                        )}

                        {dialogStrategy.linkedWorkspaces.length > 0 && (
                          <section>
                            <h4 className="mb-2 text-sm font-semibold text-slate-900">关联工作空间</h4>
                            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                              {dialogStrategy.linkedWorkspaces.map((ws) => (
                                <Link key={ws.id} href={`/${ws.id}/chat`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-slate-50">
                                  <div className="min-w-0"><p className="font-medium text-slate-900">{ws.name}</p><p className="text-xs text-slate-500">{ws.capabilityId} · {formatDate(ws.updatedAt ?? ws.createdAt)}</p></div>
                                  <ArrowRight className="h-4 w-4 text-slate-300" />
                                </Link>
                              ))}
                            </div>
                          </section>
                        )}
                      </div>

                      <div className="shrink-0 border-t border-slate-100 bg-slate-50/80 px-6 py-4">
                        <div className="flex items-center gap-3">
                          <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="输入标的代码，例如 510300" className="h-10 max-w-[180px] bg-white" />
                          <Button onClick={createStrategyWorkspace} disabled={isCreating} className="flex-1 bg-blue-600 text-white hover:bg-blue-700">
                            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                            基于此策略生成工作空间
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </>
        )}

        {view === "factors" && (
          <FactorCatalogView data={data} />
        )}

        {view === "sectorFlow" && (
          <SectorCapitalFlowView data={data} />
        )}

        {view === "foundation" && (
          <FoundationView data={data} onRefresh={refresh} />
        )}

        {view === "knowledge" && (
          <FinancialKnowledgeView />
        )}

        {/* ── Scans & Compare: Single-template view ──────── */}
        {(view === "scans" || view === "compare") && (
          <>
            <StrategySelector
              templates={filteredTemplates}
              selectedId={selectedId}
              keyword={keyword}
              onKeywordChange={setKeyword}
              onSelect={selectTemplate}
            />
            {!selectedTemplate && !filteredTemplates.length ? (
              <EmptyState title="暂无策略模板" description="请运行策略扫描生成模板数据" className="border-0" />
            ) : selectedTemplate ? (
              <>
                {/* Template overview header */}
                <div className="rounded-lg border border-slate-200 bg-white p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-bold text-slate-950">{selectedTemplate.name}</h2>
                        <Badge variant="outline" className={riskClass(selectedTemplate.readiness.riskLevel)}>{selectedTemplate.readiness.label}</Badge>
                        <Badge variant="outline" className={statusClass(selectedTemplate.status)}>{statusLabel(selectedTemplate.status)}</Badge>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-600">{selectedTemplate.description}</p>
                    </div>
                  </div>
                </div>

            {/* ── Tab: Scans ──────────────────────────── */}
            {view === "scans" && (
              <div className="space-y-4">
                {selectedTemplate.parameterScans.length === 0 ? (
                  <EmptyState title="暂无参数扫描" description="当前策略未配置参数扫描矩阵" className="border-0" />
                ) : (
                  selectedTemplate.parameterScans.map((scan) => (
                    <div key={scan.id} className="rounded-lg border border-slate-200 bg-white p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-slate-950">{scan.name}</h3>
                          <p className="mt-1 text-sm text-slate-600">{scan.objective}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={scanStatusClass(scan.status)}>{scanStatusLabel(scan.status)}</Badge>
                          <Button
                            size="sm"
                            variant={scan.status === "available" ? "default" : "outline"}
                            onClick={() => runScan(scan.id)}
                            disabled={scan.status !== "available" || Boolean(runningScanId)}
                            className={scan.status === "available" ? "bg-blue-600 text-white hover:bg-blue-700" : ""}
                          >
                            {runningScanId === scan.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                            加入队列
                          </Button>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        {scan.grid.map((item) => (
                          <div key={item.key} className="rounded-md bg-slate-50 p-3">
                            <p className="text-xs font-medium text-slate-500">{item.key}</p>
                            <p className="mt-2 text-sm font-semibold text-slate-950">
                              {item.values.map((v) => `${v}${item.unit ?? ""}`).join(" / ")}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <div>
                          <p className="text-xs font-medium text-slate-500">观测指标</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {scan.metrics.map((m) => (
                              <span key={m} className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">{m}</span>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-slate-500">执行护栏 · {scan.sampleSize} 组</p>
                          <div className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
                            {scan.guardrails.map((g) => <p key={g}>{g}</p>)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}

                {selectedTemplate.latestScanRun && (
                  <div className="rounded-lg border border-slate-200 bg-white p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-slate-950">最新扫描报告</h3>
                        <p className="mt-1 text-xs text-slate-500">
                          {selectedTemplate.latestScanRun.symbol} · {formatDate(selectedTemplate.latestScanRun.completedAt)} · {selectedTemplate.latestScanRun.source}
                        </p>
                      </div>
                      <Badge variant="outline" className={
                        selectedTemplate.latestScanRun.status === "completed" ? "border-emerald-200 bg-emerald-50 text-emerald-700" :
                        selectedTemplate.latestScanRun.status === "partial" ? "border-amber-200 bg-amber-50 text-amber-700" :
                        "border-red-200 bg-red-50 text-red-700"
                      }>{selectedTemplate.latestScanRun.status}</Badge>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-4">
                      {[
                        { label: "总组合", value: selectedTemplate.latestScanRun.total },
                        { label: "成功", value: selectedTemplate.latestScanRun.succeeded },
                        { label: "失败", value: selectedTemplate.latestScanRun.failed },
                        { label: "最优结果", value: selectedTemplate.latestScanRun.bestResultId ?? "-" },
                      ].map((item) => (
                        <div key={item.label} className="rounded-md bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">{item.label}</p>
                          <p className="mt-1 font-semibold text-slate-950">{item.value}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full min-w-[760px] text-left text-sm">
                        <thead className="text-xs text-slate-500">
                          <tr className="border-b border-slate-100">
                            <th className="py-2 pr-3 font-medium">参数</th>
                            <th className="py-2 pr-3 font-medium">收益</th>
                            <th className="py-2 pr-3 font-medium">回撤</th>
                            <th className="py-2 pr-3 font-medium">胜率</th>
                            <th className="py-2 pr-3 font-medium">交易</th>
                            <th className="py-2 pr-3 font-medium">状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedTemplate.latestScanRun.results.slice(0, 12).map((r) => (
                            <tr key={r.id} className="border-b border-slate-50">
                              <td className="py-2 pr-3 font-mono text-xs text-slate-600">
                                {Object.entries(r.parameters).map(([k, v]) => `${k}=${v}`).join(", ")}
                              </td>
                              <td className="py-2 pr-3 text-slate-900">{r.metrics.totalReturnPct ?? "-"}</td>
                              <td className="py-2 pr-3 text-slate-900">{r.metrics.maxDrawdownPct ?? "-"}</td>
                              <td className="py-2 pr-3 text-slate-900">{r.metrics.winRatePct ?? "-"}</td>
                              <td className="py-2 pr-3 text-slate-900">{r.metrics.tradeCount ?? "-"}</td>
                              <td className="py-2 pr-3">
                                <span className={r.status === "success" ? "text-emerald-700" : r.status === "skipped" ? "text-amber-700" : "text-red-700"}>{r.status}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Tab: Compare ────────────────────────── */}
            {view === "compare" && (
              <div className="rounded-lg border border-slate-200 bg-white">
                <h3 className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
                  <SquareStack className="h-4 w-4 text-blue-600" />扫描结果对比
                </h3>
                {selectedTemplate.latestScanRun ? (
                  <div className="space-y-4 p-5">
                    <div className="grid gap-3 sm:grid-cols-4">
                      {[
                        { label: "报告", value: selectedTemplate.latestScanRun.id },
                        { label: "标的", value: selectedTemplate.latestScanRun.symbol },
                        { label: "成功组合", value: `${selectedTemplate.latestScanRun.succeeded}/${selectedTemplate.latestScanRun.total}` },
                        { label: "最优参数", value: selectedTemplate.latestScanRun.bestResultId ?? "-" },
                      ].map((item) => (
                        <div key={item.label} className="rounded-md bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">{item.label}</p>
                          <p className="mt-1 truncate font-semibold text-slate-950">{item.value}</p>
                        </div>
                      ))}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[860px] text-left text-sm">
                        <thead className="text-xs text-slate-500">
                          <tr className="border-b border-slate-100">
                            <th className="py-2 pr-3 font-medium">#</th>
                            <th className="py-2 pr-3 font-medium">参数</th>
                            <th className="py-2 pr-3 font-medium">收益</th>
                            <th className="py-2 pr-3 font-medium">回撤</th>
                            <th className="py-2 pr-3 font-medium">胜率</th>
                            <th className="py-2 pr-3 font-medium">交易</th>
                            <th className="py-2 pr-3 font-medium">Sharpe</th>
                          </tr>
                        </thead>
                        <tbody>
                          {comparisonResults.map((r, i) => (
                            <tr key={r.id} className={r.id === selectedTemplate.latestScanRun?.bestResultId ? "border-b border-blue-100 bg-blue-50/70" : "border-b border-slate-50"}>
                              <td className="py-2 pr-3 font-medium text-slate-900">{i + 1}</td>
                              <td className="py-2 pr-3 font-mono text-xs text-slate-600">{Object.entries(r.parameters).map(([k, v]) => `${k}=${v}`).join(", ")}</td>
                              <td className="py-2 pr-3 tabular-nums text-slate-900">{formatMetric(r.metrics.totalReturnPct, "%")}</td>
                              <td className="py-2 pr-3 tabular-nums text-slate-900">{formatMetric(r.metrics.maxDrawdownPct, "%")}</td>
                              <td className="py-2 pr-3 tabular-nums text-slate-900">{formatMetric(r.metrics.winRatePct, "%")}</td>
                              <td className="py-2 pr-3 tabular-nums text-slate-900">{r.metrics.tradeCount ?? "-"}</td>
                              <td className="py-2 pr-3 tabular-nums text-slate-900">{formatMetric(r.metrics.sharpe)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <EmptyState title="暂无扫描结果" description="先在参数扫描页加入扫描队列" className="border-0 m-5" />
                )}
              </div>
            )}

            {/* Linked workspaces — always visible */}
            {selectedTemplate.linkedWorkspaces.length > 0 && (
              <section className="rounded-lg border border-slate-200 bg-white">
                <h3 className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
                  <GitBranch className="h-4 w-4 text-blue-600" />关联工作空间
                  <Badge variant="outline" className="bg-white text-slate-500">{selectedTemplate.linkedWorkspaces.length}</Badge>
                </h3>
                <div className="divide-y divide-slate-100">
                  {selectedTemplate.linkedWorkspaces.map((ws) => (
                    <Link
                      key={ws.id}
                      href={`/${ws.id}/chat`}
                      className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-slate-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-950">{ws.name}</p>
                        <p className="mt-1 text-xs text-slate-500">{ws.capabilityId} · {formatDate(ws.updatedAt ?? ws.createdAt)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="bg-white text-slate-500">{ws.status ?? "-"}</Badge>
                        <ArrowRight className="h-4 w-4 text-slate-300" />
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : null}
          </>
        )}
      </main>
    </div>
  );
}
