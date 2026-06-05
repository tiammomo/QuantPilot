"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import {
  Activity,
  CheckCircle2,
  ClipboardList,
  Cpu,
  FolderOpen,
  Gauge,
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

type Props = { data: QuantEvalDashboardData };
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const EVAL_PLATFORM_ACCENT = {
  "--primary": "221 83% 53%",
  "--primary-foreground": "0 0% 100%",
  "--ring": "221 83% 53%",
} as CSSProperties;

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
  const [evalSetPageSize, setEvalSetPageSize] = useState(10);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const limit = "all";
  const [selectedEvaluatorId, setSelectedEvaluatorId] = useState<EvalEvaluatorId>("rule-strict");
  const [evaluatorConcurrency, setEvaluatorConcurrency] = useState(getEvalEvaluatorOption("rule-strict").defaultConcurrency);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [isStarting, setIsStarting] = useState(false);
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
    try {
      const r = await fetch(`${API_BASE}/api/evals`, { cache: "no-store" });
      const p = await r.json();
      if (!r.ok || !p.success) throw new Error(p.error ?? "刷新失败");
      setDashboard(p.data);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : String(error));
    }
  }, [showToast]);

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
          selectedCases: sc,
          limit: caseOverride || sc.length > 0 || limit === "all" ? null : Number(limit),
          keepProjects: false,
        }),
      });
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
  const viewTitle: Record<EvalView, string> = {
    overview: "仪表盘",
    cases: "测试用例",
    evalSets: "评测集",
    evaluator: "评测器",
    queue: activeQueueCount > 0 ? "运行中" : "运行历史",
  };

  return (
    <div className="flex h-screen bg-background text-foreground" style={EVAL_PLATFORM_ACCENT}>
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border/30 bg-card/70">
        {/* Logo */}
        <div className="flex h-14 items-center gap-3 border-b border-border/30 px-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/20 text-primary">
            <Gauge className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-foreground">评测平台</h1>
            <p className="text-[10px] text-muted-foreground">智能体控制台</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-0.5 px-3 py-3">
          {VIEW_TABS.map((tab) => {
            const isActive = activeView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveView(tab.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                )}
              >
                <tab.icon className="h-4 w-4" />
                <span>{tab.label}</span>
                {tab.id === "queue" && activeQueueCount > 0 && (
                  <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-400">
                    {activeQueueCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Sidebar footer */}
        <div className="border-t border-border/30 px-3 py-3">
          <Button variant="ghost" size="sm" asChild className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground">
            <Link href="/">
              <span className="text-xs">返回首页</span>
            </Link>
          </Button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/30 bg-card/50 px-6 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-foreground">{viewTitle[activeView]}</h2>
            {activeQueueCount > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-400">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span className="font-semibold tabular-nums">{activeQueueCount}</span>
                <span>运行中</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle compact />
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] space-y-5 px-6 py-5">
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
              />
            )}

          </div>
        </main>
      </div>
    </div>
  );
}
