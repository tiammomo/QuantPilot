"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Cpu,
  FolderOpen,
  Gauge,
  Loader2,
  Play,
  RefreshCcw,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EvalCasesView } from "@/components/quant/eval-cases-view";
import { EvalEvaluatorView } from "@/components/quant/eval-evaluator-view";
import { EvalOverviewView } from "@/components/quant/eval-overview-view";
import { EvalQueueView } from "@/components/quant/eval-queue-view";
import { EvalSetsView } from "@/components/quant/eval-sets-view";
import {
  EVAL_SET_PAGE_SIZE,
  FALLBACK_RUNTIME,
  buildEvalSets,
  getEvalSetStats,
  getInitialRuntime,
  getLatestRunDelta,
  getReasoningEffort,
  getRuntimeOption,
  hasActiveQueue,
  type EvalSet,
  type EvalView,
} from "@/components/quant/eval-console-primitives";
import type { QuantEvalDashboardData, QuantEvalFlowSimulation, QuantEvalResult } from "@/lib/quant/evals";
import { cn } from "@/lib/utils";

type Props = { data: QuantEvalDashboardData };
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

const VIEW_TABS: { id: EvalView; label: string; icon: typeof Gauge }[] = [
  { id: "overview", label: "仪表盘", icon: Gauge },
  { id: "cases", label: "测试用例", icon: ClipboardList },
  { id: "evalSets", label: "评测集", icon: FolderOpen },
  { id: "evaluator", label: "评测器", icon: Cpu },
  { id: "queue", label: "运行历史", icon: Activity },
];

export default function EvalsDashboardClient({ data }: Props) {
  const [dashboard, setDashboard] = useState(data);
  const [activeView, setActiveView] = useState<EvalView>("overview");
  const [caseKeyword, setCaseKeyword] = useState("");
  const [selectedEvalSetId, setSelectedEvalSetId] = useState("all");
  const [evalSetKeyword, setEvalSetKeyword] = useState("");
  const [evalSetCategoryFilter, setEvalSetCategoryFilter] = useState("all");
  const [evalSetPage, setEvalSetPage] = useState(1);
  const [selectedCase, setSelectedCase] = useState("all");
  const [limit, setLimit] = useState("all");
  const initialRuntime = getInitialRuntime(data);
  const initialScheduleRuntime = getRuntimeOption(data.runtimeOptions, data.schedule.cli || initialRuntime.cli);
  const [benchmarkCli, setBenchmarkCli] = useState(initialRuntime.cli);
  const [benchmarkModel, setBenchmarkModel] = useState(initialRuntime.defaultModel);
  const [benchmarkReasoningEffort, setBenchmarkReasoningEffort] = useState(getReasoningEffort(initialRuntime, "low"));
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [isSimulatingFlow, setIsSimulatingFlow] = useState(false);
  const [flowSimulation, setFlowSimulation] = useState<QuantEvalFlowSimulation | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(data.schedule.enabled);
  const [scheduleInterval, setScheduleInterval] = useState(String(data.schedule.intervalHours));
  const [scheduleCli, setScheduleCli] = useState(initialScheduleRuntime.cli);
  const [scheduleModel, setScheduleModel] = useState(data.schedule.model || initialScheduleRuntime.defaultModel);
  const [scheduleReasoningEffort, setScheduleReasoningEffort] = useState(getReasoningEffort(initialScheduleRuntime, data.schedule.reasoningEffort || "low"));
  const [scheduleCase, setScheduleCase] = useState(data.schedule.selectedCases[0] ?? "all");

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
  const evalSetPageCount = Math.max(1, Math.ceil(filteredEvalSets.length / EVAL_SET_PAGE_SIZE));
  const pagedEvalSets = filteredEvalSets.slice(
    (Math.min(evalSetPage, evalSetPageCount) - 1) * EVAL_SET_PAGE_SIZE,
    Math.min(evalSetPage, evalSetPageCount) * EVAL_SET_PAGE_SIZE
  );

  const runtimeOptions = dashboard.runtimeOptions.length ? dashboard.runtimeOptions : data.runtimeOptions.length ? data.runtimeOptions : [FALLBACK_RUNTIME];
  const benchmarkRuntime = getRuntimeOption(runtimeOptions, benchmarkCli);
  const benchmarkRuntimeSupportsReasoning = benchmarkRuntime.supportsReasoningEffort;
  const scheduleRuntime = getRuntimeOption(runtimeOptions, scheduleCli);
  const scheduleRuntimeSupportsReasoning = scheduleRuntime.supportsReasoningEffort;

  const updateBenchmarkCli = (cli: string) => {
    const rt = getRuntimeOption(runtimeOptions, cli);
    setBenchmarkCli(cli); setBenchmarkModel(rt.defaultModel); setBenchmarkReasoningEffort(getReasoningEffort(rt, benchmarkReasoningEffort));
  };
  const updateScheduleCli = (cli: string) => {
    const rt = getRuntimeOption(runtimeOptions, cli);
    setScheduleCli(cli); setScheduleModel(rt.defaultModel); setScheduleReasoningEffort(getReasoningEffort(rt, scheduleReasoningEffort));
  };
  const selectEvalSet = (id: string) => { setSelectedEvalSetId(id); setSelectedCase("all"); };
  const startSelectedEvalSet = () => startBenchmark(undefined, selectedEvalSet);

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
    } finally { setIsRefreshing(false); }
  }, [showToast]);

  useEffect(() => { if (!activeQueue) return; const t = setInterval(() => { void refreshDashboard(); }, 3000); return () => clearInterval(t); }, [activeQueue, refreshDashboard]);
  useEffect(() => { setEvalSetPage(1); }, [evalSetCategoryFilter, evalSetKeyword]);
  useEffect(() => { if (evalSetPage > evalSetPageCount) setEvalSetPage(evalSetPageCount); }, [evalSetPage, evalSetPageCount]);

  const startBenchmark = async (caseOverride?: string, setOverride?: EvalSet | null) => {
    setIsStarting(true); setToast(null);
    const active = setOverride ?? selectedEvalSet;
    const sc = caseOverride ? [caseOverride] : selectedCase === "all" && active.id !== "all" ? active.caseIds : selectedCase === "all" ? [] : [selectedCase];
    try {
      const r = await fetch(`${API_BASE}/api/evals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start-benchmark", cli: benchmarkCli, model: benchmarkModel || benchmarkRuntime.defaultModel, reasoningEffort: benchmarkRuntimeSupportsReasoning ? benchmarkReasoningEffort : undefined, selectedCases: sc, limit: caseOverride || sc.length > 0 || limit === "all" ? null : Number(limit), keepProjects: false }) });
      const p = await r.json();
      if (!r.ok || !p.success) throw new Error(p.error ?? "启动失败");
      showToast("success", "评测任务已进入队列。");
      await refreshDashboard();
    } catch (error) { showToast("error", error instanceof Error ? error.message : String(error)); }
    finally { setIsStarting(false); }
  };

  const simulateFlow = async () => {
    setIsSimulatingFlow(true); setToast(null);
    const sc = selectedEvalSet.id === "all" ? [] : selectedEvalSet.caseIds;
    try {
      const r = await fetch(`${API_BASE}/api/evals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "simulate-flow", cli: benchmarkCli, model: benchmarkModel || benchmarkRuntime.defaultModel, reasoningEffort: benchmarkRuntimeSupportsReasoning ? benchmarkReasoningEffort : undefined, selectedCases: sc, limit: sc.length || limit === "all" ? null : Number(limit), keepProjects: false }) });
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

  const saveSchedule = async () => {
    setIsSavingSchedule(true); setToast(null);
    try {
      const r = await fetch(`${API_BASE}/api/evals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update-schedule", enabled: scheduleEnabled, intervalHours: Number(scheduleInterval), cli: scheduleCli, model: scheduleModel || scheduleRuntime.defaultModel, reasoningEffort: scheduleRuntimeSupportsReasoning ? scheduleReasoningEffort : undefined, selectedCases: scheduleCase === "all" ? [] : [scheduleCase], limit: null, keepProjects: false }) });
      const p = await r.json();
      if (!r.ok || !p.success) throw new Error(p.error ?? "保存失败");
      showToast("success", "定时回归配置已保存。");
      await refreshDashboard();
    } catch (error) { showToast("error", error instanceof Error ? error.message : String(error)); }
    finally { setIsSavingSchedule(false); }
  };

  const checkScheduleNow = async () => {
    setToast(null);
    try {
      const r = await fetch(`${API_BASE}/api/evals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "check-schedule" }) });
      const p = await r.json();
      if (!r.ok || !p.success) throw new Error(p.error ?? "检查失败");
      showToast("success", p.data.queued ? "已加入评测队列。" : "未到触发时间。");
      await refreshDashboard();
    } catch (error) { showToast("error", error instanceof Error ? error.message : String(error)); }
  };

  const latestResultByCase = useMemo(() => {
    const map = new Map<string, QuantEvalResult>();
    latestRun?.results.forEach((r) => { map.set(r.id, r); map.set(r.name, r); });
    return map;
  }, [latestRun]);
  const selectedEvalSetStats = getEvalSetStats(selectedEvalSet, latestResultByCase);
  const filteredCases = useMemo(() => {
    const kw = caseKeyword.trim().toLowerCase();
    if (!kw) return selectedEvalSetCases;
    return selectedEvalSetCases.filter((c) => [c.id, c.name, c.question, c.capabilityLabel, c.typeLabel, ...c.expectedSymbols, ...c.tags].join(" ").toLowerCase().includes(kw));
  }, [caseKeyword, selectedEvalSetCases]);
  const viewBadge: Record<EvalView, string> = {
    overview: `${dashboard.summary.caseCount} 用例`,
    cases: `${filteredCases.length}/${dashboard.cases.length}`,
    evalSets: `${filteredEvalSets.length}/${evalSets.length}`,
    evaluator: `${runtimeOptions.length} 个`,
    queue: activeQueueCount > 0 ? `${activeQueueCount} 运行中` : `${dashboard.queue.length} 条`,
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Top navigation */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b bg-background/80 px-4 backdrop-blur-xl md:px-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild className="shrink-0 h-8 w-8">
            <Link href="/" aria-label="返回首页">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-sm">
            <Gauge className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">评测平台</h1>
            <p className="text-[11px] text-muted-foreground hidden sm:block">
              Agent 评测控制台
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 md:flex">
            <Badge variant="secondary" className="text-xs">{viewBadge[activeView]}</Badge>
            {activeQueueCount > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                <span className="font-semibold tabular-nums">{activeQueueCount}</span>
                <span>运行中</span>
              </div>
            )}
          </div>

          <div className="h-4 w-px bg-border hidden md:block" />

          <Button variant="ghost" size="sm" onClick={refreshDashboard} disabled={isRefreshing} className="gap-1.5 text-xs">
            <RefreshCcw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
            <span className="hidden sm:inline">刷新</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={checkScheduleNow} className="gap-1.5 text-xs">
            <CalendarClock className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">检查定时</span>
          </Button>
          <Button size="sm" onClick={startSelectedEvalSet} disabled={isStarting} className="gap-1.5 text-xs">
            {isStarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">启动评测</span>
          </Button>
        </div>
      </header>

      {/* Sub navigation */}
      <nav className="sticky top-14 z-20 flex items-center gap-1 border-b border-border/40 bg-background/80 px-4 backdrop-blur-xl md:px-6">
        <div className="flex h-10 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist">
          {VIEW_TABS.map((tab) => {
            const isActive = activeView === tab.id;
            const label = tab.id === "queue" && activeQueueCount > 0 ? "运行中" : tab.label;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveView(tab.id)}
                className={cn(
                  "relative flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md px-3 text-sm font-medium transition-colors",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <tab.icon className="h-3.5 w-3.5" />
                <span>{label}</span>
                {isActive && (
                  <motion.span
                    layoutId="eval-tab-indicator"
                    className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t-full bg-primary"
                  />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 lg:px-6">
          {/* Toast */}
          <AnimatePresence>
            {toast && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
              >
                <div className={cn(
                  "flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-sm backdrop-blur-xl",
                  toast.type === "success"
                    ? "border-emerald-200/60 bg-emerald-50/90 text-emerald-800"
                    : "border-red-200/60 bg-red-50/90 text-red-800"
                )}>
                  {toast.type === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                  {toast.message}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {activeView === "overview" && (
            <EvalOverviewView
              dashboard={dashboard} latestRun={latestRun} delta={delta} activeQueueCount={activeQueueCount}
              evalSets={evalSets} selectedEvalSetId={selectedEvalSetId} limit={limit}
              runtimeOptions={runtimeOptions} benchmarkCli={benchmarkCli} benchmarkModel={benchmarkModel}
              benchmarkReasoningEffort={benchmarkReasoningEffort} benchmarkRuntime={benchmarkRuntime}
              benchmarkRuntimeSupportsReasoning={benchmarkRuntimeSupportsReasoning}
              isStarting={isStarting} onSelectedEvalSetChange={selectEvalSet}
              onBenchmarkCliChange={updateBenchmarkCli} onBenchmarkModelChange={setBenchmarkModel}
              onBenchmarkReasoningEffortChange={setBenchmarkReasoningEffort} onLimitChange={setLimit}
              onStart={startSelectedEvalSet}
            />
          )}

          {activeView === "cases" && (
            <EvalCasesView
              caseKeyword={caseKeyword} selectedCase={selectedCase} totalCaseCount={dashboard.cases.length}
              filteredCases={filteredCases} selectedEvalSetCases={selectedEvalSetCases}
              latestRun={latestRun} latestResultByCase={latestResultByCase} isStarting={isStarting}
              onCaseKeywordChange={setCaseKeyword} onSelectedCaseChange={setSelectedCase}
              onRunSelection={() => startBenchmark()} onRunCase={(caseId) => startBenchmark(caseId)}
            />
          )}

          {activeView === "evalSets" && (
            <EvalSetsView
              evalSets={evalSets} filteredEvalSets={filteredEvalSets} pagedEvalSets={pagedEvalSets}
              selectedEvalSet={selectedEvalSet} selectedEvalSetStats={selectedEvalSetStats}
              latestResultByCase={latestResultByCase} evalSetKeyword={evalSetKeyword}
              evalSetCategoryFilter={evalSetCategoryFilter} evalSetCategories={evalSetCategories}
              evalSetPage={evalSetPage} evalSetPageCount={evalSetPageCount} isStarting={isStarting}
              onEvalSetKeywordChange={setEvalSetKeyword} onEvalSetCategoryFilterChange={setEvalSetCategoryFilter}
              onEvalSetSelect={selectEvalSet} onEvalSetPageChange={setEvalSetPage} onRunSelectedEvalSet={startSelectedEvalSet}
            />
          )}

          {activeView === "evaluator" && (
            <EvalEvaluatorView
              runtimeOptions={runtimeOptions} benchmarkCli={benchmarkCli} benchmarkModel={benchmarkModel}
              benchmarkReasoningEffort={benchmarkReasoningEffort} benchmarkRuntime={benchmarkRuntime}
              benchmarkRuntimeSupportsReasoning={benchmarkRuntimeSupportsReasoning}
              evalSets={evalSets} selectedEvalSetId={selectedEvalSetId} selectedEvalSet={selectedEvalSet}
              flowSimulation={flowSimulation} isSimulatingFlow={isSimulatingFlow} isStarting={isStarting}
              onBenchmarkCliChange={updateBenchmarkCli} onBenchmarkModelChange={setBenchmarkModel}
              onBenchmarkReasoningEffortChange={setBenchmarkReasoningEffort} onEvalSetSelect={selectEvalSet}
              onSimulateFlow={simulateFlow} onStart={startSelectedEvalSet}
            />
          )}

          {activeView === "queue" && (
            <EvalQueueView
              queue={dashboard.queue} schedule={dashboard.schedule} cases={dashboard.cases}
              runtimeOptions={runtimeOptions} scheduleRuntime={scheduleRuntime}
              scheduleRuntimeSupportsReasoning={scheduleRuntimeSupportsReasoning}
              scheduleEnabled={scheduleEnabled} scheduleInterval={scheduleInterval}
              scheduleCli={scheduleCli} scheduleModel={scheduleModel} scheduleReasoningEffort={scheduleReasoningEffort}
              scheduleCase={scheduleCase} isSavingSchedule={isSavingSchedule}
              onCancelBenchmark={cancelBenchmark} onScheduleEnabledChange={setScheduleEnabled}
              onScheduleIntervalChange={setScheduleInterval} onScheduleCliChange={updateScheduleCli}
              onScheduleModelChange={setScheduleModel} onScheduleReasoningEffortChange={setScheduleReasoningEffort}
              onScheduleCaseChange={setScheduleCase} onSaveSchedule={saveSchedule}
            />
          )}

        </div>
      </main>
    </div>
  );
}
