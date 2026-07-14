"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Cpu,
  FolderOpen,
  Gauge,
  Play,
  RefreshCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { EvalCasesView } from "@/components/quant/eval-cases-view";
import {
  EvalEvaluatorView,
  getEvalEvaluatorOption,
  type EvalEvaluatorId,
} from "@/components/quant/eval-evaluator-view";
import { EvalOverviewView } from "@/components/quant/eval-overview-view";
import { EvalQueueView } from "@/components/quant/eval-queue-view";
import { EvalSetsView } from "@/components/quant/eval-sets-view";
import {
  buildEvalSets,
  getLatestRunDelta,
  hasActiveQueue,
  type EvalSet,
  type EvalView,
} from "@/components/quant/eval-console-primitives";
import type { QuantEvalDashboardData, QuantEvalFlowSimulation, QuantEvalResult } from "@/lib/eval";
import { cn } from "@/lib/utils";
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher";

type Props = { data: QuantEvalDashboardData };
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const VIEW_TABS: { id: EvalView; label: string; icon: typeof Gauge }[] = [
  { id: "overview", label: "质量总览", icon: Gauge },
  { id: "cases", label: "测试用例", icon: ClipboardList },
  { id: "evalSets", label: "评测集", icon: FolderOpen },
  { id: "evaluator", label: "评测器", icon: Cpu },
  { id: "queue", label: "运行历史", icon: Activity },
];

const VIEW_META: Record<EvalView, { eyebrow: string; title: string; description: string }> = {
  overview: {
    eyebrow: "QUALITY COMMAND CENTER",
    title: "质量总览",
    description: "汇总评测覆盖、质量基线与当前执行状态。",
  },
  cases: {
    eyebrow: "TEST INVENTORY",
    title: "测试用例",
    description: "维护输入场景、预期契约与能力覆盖。",
  },
  evalSets: {
    eyebrow: "EVALUATION DATASETS",
    title: "评测集",
    description: "将用例组织成可复用、可追踪的回归范围。",
  },
  evaluator: {
    eyebrow: "RUN CONFIGURATION",
    title: "评测器",
    description: "选择评测策略，验证链路并发起一次质量评估。",
  },
  queue: {
    eyebrow: "EXECUTION CENTER",
    title: "运行历史",
    description: "跟踪队列进度、执行结果与评测报告。",
  },
};

function isEvalView(value: string | null): value is EvalView {
  return VIEW_TABS.some((tab) => tab.id === value);
}

function formatGeneratedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚同步";
  return `同步于 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export default function EvalsDashboardClient({ data }: Props) {
  const [dashboard, setDashboard] = useState(data);
  const [activeView, setActiveView] = useState<EvalView>("overview");
  const [caseKeyword, setCaseKeyword] = useState("");
  const [selectedEvalSetId, setSelectedEvalSetId] = useState("all");
  const [evalSetKeyword, setEvalSetKeyword] = useState("");
  const [evalSetCategoryFilter, setEvalSetCategoryFilter] = useState("all");
  const [evalSetPage, setEvalSetPage] = useState(1);
  const [evalSetPageSize, setEvalSetPageSize] = useState(10);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const limit = "all";
  const [selectedEvaluatorId, setSelectedEvaluatorId] = useState<EvalEvaluatorId>("rule-strict");
  const [evaluatorConcurrency, setEvaluatorConcurrency] = useState(getEvalEvaluatorOption("rule-strict").defaultConcurrency);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSimulatingFlow, setIsSimulatingFlow] = useState(false);
  const [flowSimulation, setFlowSimulation] = useState<QuantEvalFlowSimulation | null>(null);

  const latestRun = dashboard.latestRun;
  const delta = getLatestRunDelta(dashboard.runs);
  const activeQueue = hasActiveQueue(dashboard.queue);
  const activeQueueCount = dashboard.queue.filter((item) => item.status === "queued" || item.status === "running").length;
  const evalSets = useMemo(() => buildEvalSets(dashboard), [dashboard]);
  const selectedEvalSet = useMemo(
    () => evalSets.find((es) => es.id === selectedEvalSetId) ?? evalSets[0] ?? { id: "all", name: "全部用例", description: "覆盖所有测试用例。", category: "系统", caseIds: [] },
    [evalSets, selectedEvalSetId]
  );
  const selectedEvalSetCaseIds = useMemo(() => new Set(selectedEvalSet.caseIds), [selectedEvalSet]);
  const selectedEvalSetCases = useMemo(
    () => selectedEvalSet?.id === "all" ? dashboard.cases : dashboard.cases.filter((c) => selectedEvalSetCaseIds.has(c.id)),
    [dashboard.cases, selectedEvalSet?.id, selectedEvalSetCaseIds]
  );
  const evalSetCategories = useMemo(() => Array.from(new Set(evalSets.map((es) => es.category))), [evalSets]);
  const filteredEvalSets = useMemo(() => {
    const kw = evalSetKeyword.trim().toLowerCase();
    return evalSets.filter((es) => {
      if (evalSetCategoryFilter !== "all" && es.category !== evalSetCategoryFilter) return false;
      if (!kw) return true;
      return [es.name, es.description, es.category, ...es.caseIds].join(" ").toLowerCase().includes(kw);
    });
  }, [evalSetCategoryFilter, evalSetKeyword, evalSets]);
  const evalSetPageCount = Math.max(1, Math.ceil(filteredEvalSets.length / evalSetPageSize));

  const selectedEvaluator = useMemo(() => getEvalEvaluatorOption(selectedEvaluatorId), [selectedEvaluatorId]);

  const selectEvaluator = (id: EvalEvaluatorId) => {
    const nextEvaluator = getEvalEvaluatorOption(id);
    setSelectedEvaluatorId(id);
    setEvaluatorConcurrency((current) => Math.min(nextEvaluator.maxConcurrency, Math.max(1, current || nextEvaluator.defaultConcurrency)));
  };
  const selectEvalSet = (id: string) => { setSelectedEvalSetId(id); setSelectedCaseIds([]); };
  const startSelectedEvalSet = () => startBenchmark(undefined, selectedEvalSet, true);
  const startEvalSet = (id: string) => {
    const evalSet = evalSets.find((item) => item.id === id);
    if (!evalSet) return;
    setSelectedEvalSetId(id);
    setSelectedCaseIds([]);
    void startBenchmark(undefined, evalSet, true);
  };

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshDashboard = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const r = await fetch(`${API_BASE}/api/evals`, { cache: "no-store" });
      const p = await r.json();
      if (!r.ok || !p.success) throw new Error(p.error ?? "刷新失败");
      setDashboard(p.data);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsRefreshing(false);
    }
  }, [showToast]);

  const changeView = useCallback((view: EvalView) => {
    setActiveView(view);
    const url = new URL(window.location.href);
    if (view === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    const applyLocation = () => {
      const view = new URL(window.location.href).searchParams.get("view");
      setActiveView(isEvalView(view) ? view : "overview");
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, []);

  useEffect(() => { if (!activeQueue) return; const t = setInterval(() => { void refreshDashboard(); }, 3000); return () => clearInterval(t); }, [activeQueue, refreshDashboard]);
  useEffect(() => { setEvalSetPage(1); }, [evalSetCategoryFilter, evalSetKeyword]);
  useEffect(() => { if (evalSetPage > evalSetPageCount) setEvalSetPage(evalSetPageCount); }, [evalSetPage, evalSetPageCount]);
  useEffect(() => {
    const validCaseIds = new Set(selectedEvalSetCases.map((testCase) => testCase.id));
    setSelectedCaseIds((current) => current.filter((caseId) => validCaseIds.has(caseId)));
  }, [selectedEvalSetCases]);
  useEffect(() => { setFlowSimulation(null); }, [selectedEvaluatorId, evaluatorConcurrency, selectedEvalSetId]);

  const startBenchmark = async (caseOverride?: string, setOverride?: EvalSet | null, forceAllCases = false) => {
    setIsStarting(true); setToast(null);
    const active = setOverride ?? selectedEvalSet;
    const sc = forceAllCases ? active.id !== "all" ? active.caseIds : [] : caseOverride ? [caseOverride] : selectedCaseIds;
    try {
      const r = await fetch(`${API_BASE}/api/evals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start-benchmark",
          evaluatorId: selectedEvaluator.id,
          cli: selectedEvaluator.cli,
          model: selectedEvaluator.model,
          reasoningEffort: selectedEvaluator.reasoningEffort,
          concurrency: evaluatorConcurrency,
          mode: selectedEvaluator.executionMode,
          selectedCases: sc,
          limit: caseOverride || sc.length > 0 || limit === "all" ? null : Number(limit),
          keepProjects: false,
        }),
      });
      const p = await r.json();
      if (!r.ok || !p.success) throw new Error(p.error ?? "启动失败");
      showToast("success", selectedEvaluator.executionMode === "e2e" ? "DeepSeek E2E 评测已进入队列。" : "确定性契约评测已进入队列。");
      await refreshDashboard();
    } catch (error) { showToast("error", error instanceof Error ? error.message : String(error)); }
    finally { setIsStarting(false); }
  };

  const simulateFlow = async () => {
    setIsSimulatingFlow(true); setToast(null);
    const sc = selectedEvalSet.id === "all" ? [] : selectedEvalSet.caseIds;
    try {
      const r = await fetch(`${API_BASE}/api/evals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "simulate-flow",
          evaluatorId: selectedEvaluator.id,
          cli: selectedEvaluator.cli,
          model: selectedEvaluator.model,
          reasoningEffort: selectedEvaluator.reasoningEffort,
          concurrency: evaluatorConcurrency,
          mode: selectedEvaluator.executionMode,
          selectedCases: sc,
          limit: sc.length || limit === "all" ? null : Number(limit),
          keepProjects: false,
        }),
      });
      const p = await r.json();
      if (!r.ok || !p.success) throw new Error(p.error ?? "模拟失败");
      setFlowSimulation(p.data);
      showToast("success", p.data.ready ? "评测链路模拟通过。" : "评测链路存在阻断项。");
    } catch (error) { showToast("error", error instanceof Error ? error.message : String(error)); }
    finally { setIsSimulatingFlow(false); }
  };

  const cancelBenchmark = async (queueId: string) => {
    setToast(null);
    try {
      const r = await fetch(`${API_BASE}/api/evals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel-benchmark", queueId }) });
      const p = await r.json();
      if (!r.ok || !p.success) throw new Error(p.error ?? "取消失败");
      showToast("success", "评测任务已取消。");
      await refreshDashboard();
    } catch (error) { showToast("error", error instanceof Error ? error.message : String(error)); }
  };

  const createEvalCase = async (payload: Record<string, unknown>) => {
    const r = await fetch(`${API_BASE}/api/evals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create-case", ...payload }),
    });
    const p = await r.json();
    if (!r.ok || !p.success) throw new Error(p.error ?? "新增测试用例失败");
    showToast("success", "测试用例已新增。");
    await refreshDashboard();
  };

  const createEvalSet = async (payload: Record<string, unknown>) => {
    const r = await fetch(`${API_BASE}/api/evals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create-eval-set", ...payload }),
    });
    const p = await r.json();
    if (!r.ok || !p.success) throw new Error(p.error ?? "新增评测集失败");
    showToast("success", "评测集已新增。");
    await refreshDashboard();
    if (p.data?.id) selectEvalSet(p.data.id);
  };

  const latestResultByCase = useMemo(() => {
    const map = new Map<string, QuantEvalResult>();
    latestRun?.results.forEach((r) => { map.set(r.id, r); map.set(r.name, r); });
    return map;
  }, [latestRun]);
  const filteredCases = useMemo(() => {
    const kw = caseKeyword.trim().toLowerCase();
    if (!kw) return selectedEvalSetCases;
    return selectedEvalSetCases.filter((c) => [c.id, c.name, c.question, c.capabilityLabel, c.typeLabel, ...c.expectedSymbols, ...c.tags].join(" ").toLowerCase().includes(kw));
  }, [caseKeyword, selectedEvalSetCases]);
  const currentView = VIEW_META[activeView];
  const baselineReady = dashboard.runs.length > 0;

  return (
    <div className="platform-shell flex h-dvh bg-background">
      {/* Sidebar */}
      <aside className="relative hidden w-[264px] shrink-0 flex-col overflow-hidden border-r border-border/60 bg-card/80 shadow-[14px_0_42px_-36px_hsl(var(--foreground)/0.5)] backdrop-blur-2xl md:flex">
        <div className="pointer-events-none absolute -left-24 -top-28 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        {/* Logo */}
        <div className="relative flex h-[76px] items-center gap-3 border-b border-border/40 px-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Sparkles className="h-[18px] w-[18px]" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-foreground">QuantPilot Evals</h1>
            <p className="mt-0.5 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground">QUALITY OPS</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="relative flex-1 px-3 py-5" aria-label="评测平台导航">
          <p className="px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">工作台</p>
          <div className="mt-2 space-y-1">
            {VIEW_TABS.slice(0, 1).map((tab) => {
              const isActive = activeView === tab.id;
              return (
                <button key={tab.id} type="button" onClick={() => changeView(tab.id)} aria-current={isActive ? "page" : undefined} className={cn("group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all", isActive ? "bg-primary text-primary-foreground shadow-md shadow-primary/15" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
                  <tab.icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-6 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">评测资产</p>
          <div className="mt-2 space-y-1">
            {VIEW_TABS.slice(1, 3).map((tab) => {
              const isActive = activeView === tab.id;
              return (
                <button key={tab.id} type="button" onClick={() => changeView(tab.id)} aria-current={isActive ? "page" : undefined} className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all", isActive ? "bg-primary text-primary-foreground shadow-md shadow-primary/15" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
                  <tab.icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-6 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">执行与报告</p>
          <div className="mt-2 space-y-1">
            {VIEW_TABS.slice(3).map((tab) => {
              const isActive = activeView === tab.id;
              return (
                <button key={tab.id} type="button" onClick={() => changeView(tab.id)} aria-current={isActive ? "page" : undefined} className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all", isActive ? "bg-primary text-primary-foreground shadow-md shadow-primary/15" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
                  <tab.icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                  {tab.id === "queue" && activeQueueCount > 0 && <span className={cn("ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold", isActive ? "bg-white/20 text-white" : "bg-amber-500/15 text-amber-500")}>{activeQueueCount}</span>}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Sidebar footer */}
        <div className="relative space-y-3 border-t border-border/40 p-3">
          <div className="rounded-xl border border-border/60 bg-background/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">系统状态</span>
              <span className={cn("h-2 w-2 rounded-full", activeQueueCount ? "animate-pulse bg-amber-500" : "bg-emerald-500")} />
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
              {activeQueueCount ? `${activeQueueCount} 个任务正在执行` : baselineReady ? "质量基线已就绪" : "等待首次基线评测"}
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild className="w-full justify-start gap-2.5 rounded-lg text-muted-foreground hover:text-foreground">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              <span className="text-xs">返回 QuantPilot</span>
            </Link>
          </Button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="platform-header flex min-h-[76px] shrink-0 items-center justify-between gap-4 px-4 py-3 md:px-6 lg:px-8">
          <div className="min-w-0">
            <p className="hidden text-[10px] font-bold tracking-[0.16em] text-primary sm:block">{currentView.eyebrow}</p>
            <div className="mt-0.5 flex items-center gap-3">
              <h2 className="truncate text-lg font-bold tracking-tight text-foreground md:text-xl">
                <span className="md:hidden">评测平台 · </span>{currentView.title}
              </h2>
            {activeQueueCount > 0 && (
              <div className="hidden items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-500 sm:flex">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span className="font-semibold tabular-nums">{activeQueueCount}</span>
                <span>运行中</span>
              </div>
            )}
            </div>
            <p className="mt-0.5 hidden truncate text-xs text-muted-foreground lg:block">{currentView.description}</p>
          </div>

          <div className="flex items-center gap-2">
            <PlatformSwitcher />
            <div className="mr-1 hidden text-right xl:block">
              <p className="text-[11px] font-medium text-foreground">{formatGeneratedAt(dashboard.generatedAt)}</p>
              <p className="text-[10px] text-muted-foreground">{dashboard.summary.caseCount} 条用例 · {dashboard.summary.capabilityCount} 个能力域</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void refreshDashboard()} disabled={isRefreshing} className="h-9 w-9 gap-2 rounded-lg px-0 sm:w-auto sm:px-3" aria-label="刷新评测数据">
              <RefreshCcw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
              <span className="hidden sm:inline">刷新</span>
            </Button>
            <Button size="sm" onClick={() => changeView("evaluator")} className="hidden h-9 gap-2 rounded-lg px-3 shadow-sm sm:flex">
              <Play className="h-3.5 w-3.5" />
              发起评测
            </Button>
            <ThemeToggle compact />
          </div>
        </header>

        <nav className="platform-nav-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-background/80 px-3 py-2 backdrop-blur md:hidden" aria-label="评测平台视图">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => changeView(tab.id)}
              aria-current={activeView === tab.id ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all",
                activeView === tab.id
                  ? "bg-primary/10 text-primary ring-1 ring-primary/15"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Main content */}
        <main className="platform-content flex-1 overflow-y-auto" id="eval-main-content">
          <div className="mx-auto max-w-[1520px] space-y-5 px-3 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-7">
            {/* Toast */}
            <AnimatePresence>
              {toast && (
                <motion.div
                  initial={{ opacity: 0, y: -10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10, scale: 0.95 }}
                >
                  <div className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm",
                    toast.type === "success"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "border-red-500/30 bg-red-500/10 text-red-400"
                  )}>
                    {toast.type === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                    {toast.message}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {activeView === "overview" && (
              <EvalOverviewView
                dashboard={dashboard} delta={delta} activeQueueCount={activeQueueCount}
                evalSets={evalSets}
                onNavigate={changeView}
              />
            )}

            {activeView === "cases" && (
              <EvalCasesView
                caseKeyword={caseKeyword} selectedCaseIds={selectedCaseIds} totalCaseCount={dashboard.cases.length}
                filteredCases={filteredCases} selectedEvalSetCases={selectedEvalSetCases}
                latestRun={latestRun} latestResultByCase={latestResultByCase} isStarting={isStarting}
                onCaseKeywordChange={setCaseKeyword} onSelectedCaseIdsChange={setSelectedCaseIds}
                onRunSelection={() => startBenchmark()}
                onCreateCase={createEvalCase}
                onRunCase={(caseId) => startBenchmark(caseId)}
              />
            )}

            {activeView === "evalSets" && (
              <EvalSetsView
                cases={dashboard.cases} runs={dashboard.runs} evalSets={evalSets} filteredEvalSets={filteredEvalSets}
                selectedEvalSet={selectedEvalSet} evalSetKeyword={evalSetKeyword}
                evalSetCategoryFilter={evalSetCategoryFilter} evalSetCategories={evalSetCategories}
                evalSetPage={evalSetPage} evalSetPageSize={evalSetPageSize} isStarting={isStarting}
                onEvalSetKeywordChange={setEvalSetKeyword} onEvalSetCategoryFilterChange={setEvalSetCategoryFilter}
                onEvalSetSelect={selectEvalSet} onEvalSetPageChange={setEvalSetPage}
                onEvalSetPageSizeChange={(pageSize) => {
                  setEvalSetPageSize(pageSize);
                  setEvalSetPage(1);
                }}
                onCreateEvalSet={createEvalSet}
                onRunEvalSet={startEvalSet}
              />
            )}

            {activeView === "evaluator" && (
              <EvalEvaluatorView
                selectedEvaluatorId={selectedEvaluatorId}
                concurrency={evaluatorConcurrency}
                evalSets={evalSets} selectedEvalSetId={selectedEvalSetId}
                flowSimulation={flowSimulation} isSimulatingFlow={isSimulatingFlow} isStarting={isStarting}
                onEvaluatorSelect={selectEvaluator}
                onConcurrencyChange={setEvaluatorConcurrency}
                onEvalSetSelect={selectEvalSet}
                onSimulateFlow={simulateFlow} onStart={startSelectedEvalSet}
              />
            )}

            {activeView === "queue" && (
              <EvalQueueView
                queue={dashboard.queue}
                runs={dashboard.runs}
                evalSets={evalSets}
                totalCaseCount={dashboard.cases.length}
                onCancelBenchmark={cancelBenchmark}
                onRefresh={refreshDashboard}
                onCreateRun={() => changeView("evaluator")}
              />
            )}

          </div>
        </main>
      </div>
    </div>
  );
}
