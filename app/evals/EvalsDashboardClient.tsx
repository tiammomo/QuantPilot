"use client";

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ClipboardList,
  Cpu,
  Database,
  FolderOpen,
  Gauge,
  Wrench,
} from 'lucide-react';
import { EvalCasesView } from '@/components/quant/eval-cases-view';
import { EvalConsoleShell, type EvalNavItem, type EvalViewMeta } from '@/components/quant/eval-console-shell';
import { EvalEvaluatorView } from '@/components/quant/eval-evaluator-view';
import { EvalOverviewView } from '@/components/quant/eval-overview-view';
import { EvalQueueView } from '@/components/quant/eval-queue-view';
import { EvalRepairsView } from '@/components/quant/eval-repairs-view';
import { EvalRunsView } from '@/components/quant/eval-runs-view';
import { EvalSetsView } from '@/components/quant/eval-sets-view';
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
} from '@/components/quant/eval-console-primitives';
import type {
  QuantEvalDashboardData,
  QuantEvalFlowSimulation,
  QuantEvalResult,
} from '@/lib/quant/evals';

type Props = {
  data: QuantEvalDashboardData;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export default function EvalsDashboardClient({ data }: Props) {
  const [dashboard, setDashboard] = useState(data);
  const [activeView, setActiveView] = useState<EvalView>('overview');
  const [caseKeyword, setCaseKeyword] = useState('');
  const [runKeyword, setRunKeyword] = useState('');
  const [selectedEvalSetId, setSelectedEvalSetId] = useState('all');
  const [evalSetKeyword, setEvalSetKeyword] = useState('');
  const [evalSetCategoryFilter, setEvalSetCategoryFilter] = useState('all');
  const [evalSetPage, setEvalSetPage] = useState(1);
  const [selectedCase, setSelectedCase] = useState('all');
  const [limit, setLimit] = useState('all');
  const initialRuntime = getInitialRuntime(data);
  const initialScheduleRuntime = getRuntimeOption(data.runtimeOptions, data.schedule.cli || initialRuntime.cli);
  const [benchmarkCli, setBenchmarkCli] = useState(initialRuntime.cli);
  const [benchmarkModel, setBenchmarkModel] = useState(initialRuntime.defaultModel);
  const [benchmarkReasoningEffort, setBenchmarkReasoningEffort] = useState(getReasoningEffort(initialRuntime, 'low'));
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [isSimulatingFlow, setIsSimulatingFlow] = useState(false);
  const [flowSimulation, setFlowSimulation] = useState<QuantEvalFlowSimulation | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(data.schedule.enabled);
  const [scheduleInterval, setScheduleInterval] = useState(String(data.schedule.intervalHours));
  const [scheduleCli, setScheduleCli] = useState(initialScheduleRuntime.cli);
  const [scheduleModel, setScheduleModel] = useState(data.schedule.model || initialScheduleRuntime.defaultModel);
  const [scheduleReasoningEffort, setScheduleReasoningEffort] = useState(
    getReasoningEffort(initialScheduleRuntime, data.schedule.reasoningEffort || 'low')
  );
  const [scheduleCase, setScheduleCase] = useState(data.schedule.selectedCases[0] ?? 'all');

  const latestRun = dashboard.latestRun;
  const delta = getLatestRunDelta(dashboard.runs);
  const activeQueue = hasActiveQueue(dashboard.queue);
  const activeQueueCount = dashboard.queue.filter((item) => item.status === 'queued' || item.status === 'running').length;
  const evalSets = useMemo(() => buildEvalSets(dashboard), [dashboard]);
  const selectedEvalSet = useMemo(
    () =>
      evalSets.find((evalSet) => evalSet.id === selectedEvalSetId) ??
      evalSets[0] ?? {
        id: 'all',
        name: '全部用例',
        description: '覆盖所有测试用例。',
        category: '系统',
        caseIds: [],
      },
    [evalSets, selectedEvalSetId]
  );
  const selectedEvalSetCaseIds = useMemo(() => new Set(selectedEvalSet.caseIds), [selectedEvalSet]);
  const selectedEvalSetCases = useMemo(
    () =>
      selectedEvalSet?.id === 'all'
        ? dashboard.cases
        : dashboard.cases.filter((testCase) => selectedEvalSetCaseIds.has(testCase.id)),
    [dashboard.cases, selectedEvalSet?.id, selectedEvalSetCaseIds]
  );
  const evalSetCategories = useMemo(() => Array.from(new Set(evalSets.map((evalSet) => evalSet.category))), [evalSets]);
  const filteredEvalSets = useMemo(() => {
    const keyword = evalSetKeyword.trim().toLowerCase();
    return evalSets.filter((evalSet) => {
      const categoryMatched = evalSetCategoryFilter === 'all' || evalSet.category === evalSetCategoryFilter;
      const keywordMatched =
        !keyword ||
        [evalSet.name, evalSet.description, evalSet.category, ...evalSet.caseIds]
          .join(' ')
          .toLowerCase()
          .includes(keyword);
      return categoryMatched && keywordMatched;
    });
  }, [evalSetCategoryFilter, evalSetKeyword, evalSets]);
  const evalSetPageCount = Math.max(1, Math.ceil(filteredEvalSets.length / EVAL_SET_PAGE_SIZE));
  const pagedEvalSets = filteredEvalSets.slice(
    (Math.min(evalSetPage, evalSetPageCount) - 1) * EVAL_SET_PAGE_SIZE,
    Math.min(evalSetPage, evalSetPageCount) * EVAL_SET_PAGE_SIZE
  );
  const runtimeOptions = dashboard.runtimeOptions.length
    ? dashboard.runtimeOptions
    : data.runtimeOptions.length
      ? data.runtimeOptions
      : [FALLBACK_RUNTIME];
  const benchmarkRuntime = getRuntimeOption(runtimeOptions, benchmarkCli);
  const benchmarkRuntimeSupportsReasoning = benchmarkRuntime.supportsReasoningEffort;
  const scheduleRuntime = getRuntimeOption(runtimeOptions, scheduleCli);
  const scheduleRuntimeSupportsReasoning = scheduleRuntime.supportsReasoningEffort;

  const updateBenchmarkCli = (cli: string) => {
    const runtime = getRuntimeOption(runtimeOptions, cli);
    setBenchmarkCli(cli);
    setBenchmarkModel(runtime.defaultModel);
    setBenchmarkReasoningEffort(getReasoningEffort(runtime, benchmarkReasoningEffort));
  };

  const updateScheduleCli = (cli: string) => {
    const runtime = getRuntimeOption(runtimeOptions, cli);
    setScheduleCli(cli);
    setScheduleModel(runtime.defaultModel);
    setScheduleReasoningEffort(getReasoningEffort(runtime, scheduleReasoningEffort));
  };

  const selectEvalSet = (evalSetId: string) => {
    setSelectedEvalSetId(evalSetId);
    setSelectedCase('all');
  };

  const startSelectedEvalSet = () => startBenchmark(undefined, selectedEvalSet);

  const refreshDashboard = async () => {
    setIsRefreshing(true);
    try {
      const response = await fetch(`${API_BASE}/api/evals`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? '刷新评测后台失败');
      }
      setDashboard(payload.data);
    } catch (error) {
      setToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!activeQueue) return;
    const timer = window.setInterval(() => {
      void refreshDashboard();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeQueue]);

  useEffect(() => {
    setEvalSetPage(1);
  }, [evalSetCategoryFilter, evalSetKeyword]);

  useEffect(() => {
    if (evalSetPage > evalSetPageCount) {
      setEvalSetPage(evalSetPageCount);
    }
  }, [evalSetPage, evalSetPageCount]);

  const startBenchmark = async (caseOverride?: string, setOverride?: EvalSet | null) => {
    setIsStarting(true);
    setToast(null);
    const caseSelection = caseOverride ?? selectedCase;
    const activeEvalSet = setOverride ?? selectedEvalSet;
    const selectedCases =
      caseOverride
        ? [caseOverride]
        : caseSelection === 'all' && activeEvalSet.id !== 'all'
          ? activeEvalSet.caseIds
          : caseSelection === 'all'
            ? []
            : [caseSelection];
    const hasExactCaseScope = Boolean(caseOverride) || selectedCases.length > 0;
    try {
      const response = await fetch(`${API_BASE}/api/evals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start-benchmark',
          cli: benchmarkCli,
          model: benchmarkModel || benchmarkRuntime.defaultModel,
          reasoningEffort: benchmarkRuntimeSupportsReasoning ? benchmarkReasoningEffort : undefined,
          selectedCases,
          limit: hasExactCaseScope || limit === 'all' ? null : Number(limit),
          keepProjects: false,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? '启动 benchmark 失败');
      }
      setToast({ type: 'success', message: '评测任务已进入队列。' });
      await refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsStarting(false);
    }
  };

  const simulateFlow = async () => {
    setIsSimulatingFlow(true);
    setToast(null);
    const selectedCases = selectedEvalSet.id === 'all' ? [] : selectedEvalSet.caseIds;
    try {
      const response = await fetch(`${API_BASE}/api/evals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'simulate-flow',
          cli: benchmarkCli,
          model: benchmarkModel || benchmarkRuntime.defaultModel,
          reasoningEffort: benchmarkRuntimeSupportsReasoning ? benchmarkReasoningEffort : undefined,
          selectedCases,
          limit: selectedCases.length || limit === 'all' ? null : Number(limit),
          keepProjects: false,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? '链路模拟失败');
      }
      setFlowSimulation(payload.data);
      setToast({ type: 'success', message: payload.data.ready ? '评测链路模拟通过。' : '评测链路存在阻断项。' });
    } catch (error) {
      setToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsSimulatingFlow(false);
    }
  };

  const cancelBenchmark = async (queueId: string) => {
    setToast(null);
    try {
      const response = await fetch(`${API_BASE}/api/evals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel-benchmark', queueId }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? '取消评测任务失败');
      }
      setToast({ type: 'success', message: '评测任务已取消。' });
      await refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const saveSchedule = async () => {
    setIsSavingSchedule(true);
    setToast(null);
    try {
      const intervalHours = Number(scheduleInterval);
      const response = await fetch(`${API_BASE}/api/evals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-schedule',
          enabled: scheduleEnabled,
          intervalHours,
          cli: scheduleCli,
          model: scheduleModel || scheduleRuntime.defaultModel,
          reasoningEffort: scheduleRuntimeSupportsReasoning ? scheduleReasoningEffort : undefined,
          selectedCases: scheduleCase === 'all' ? [] : [scheduleCase],
          limit: null,
          keepProjects: false,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? '保存定时回归配置失败');
      }
      setToast({ type: 'success', message: '定时回归配置已保存。' });
      await refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsSavingSchedule(false);
    }
  };

  const checkScheduleNow = async () => {
    setToast(null);
    try {
      const response = await fetch(`${API_BASE}/api/evals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check-schedule' }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? '检查定时回归失败');
      }
      setToast({ type: 'success', message: payload.data.queued ? '已按定时配置加入评测队列。' : '当前未到定时触发时间。' });
      await refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const latestResultByCase = useMemo(() => {
    const map = new Map<string, QuantEvalResult>();
    latestRun?.results.forEach((result) => {
      map.set(result.id, result);
      map.set(result.name, result);
    });
    return map;
  }, [latestRun]);
  const selectedEvalSetStats = getEvalSetStats(selectedEvalSet, latestResultByCase);

  const filteredCases = useMemo(() => {
    const keyword = caseKeyword.trim().toLowerCase();
    if (!keyword) return selectedEvalSetCases;
    return selectedEvalSetCases.filter((testCase) =>
      [
        testCase.id,
        testCase.name,
        testCase.question,
        testCase.capabilityLabel,
        testCase.typeLabel,
        ...testCase.expectedSymbols,
        ...testCase.tags,
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    );
  }, [caseKeyword, selectedEvalSetCases]);

  const filteredRuns = useMemo(() => {
    const keyword = runKeyword.trim().toLowerCase();
    if (!keyword) return dashboard.runs;
    return dashboard.runs.filter((run) =>
      [
        run.id,
        run.fileName,
        run.passed ? '通过' : '失败',
        run.metadata.runtime.cli,
        run.metadata.runtime.model,
        ...Object.keys(run.coverage.byCapability),
        ...run.results.map((result) => result.name),
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    );
  }, [dashboard.runs, runKeyword]);

  const warningResults =
    latestRun?.results.filter((result) =>
      result.validationChecks.some((check) => check.status === 'warning')
    ) ?? [];
  const navItems: EvalNavItem[] = [
    { view: 'overview', label: '仪表盘', icon: <Gauge className="h-4 w-4" /> },
    { view: 'cases', label: '测试用例', icon: <ClipboardList className="h-4 w-4" /> },
    { view: 'evalSets', label: '评测集', icon: <FolderOpen className="h-4 w-4" /> },
    { view: 'evaluator', label: '评测器', icon: <Cpu className="h-4 w-4" /> },
    { view: 'queue', label: '运行队列', icon: <Activity className="h-4 w-4" /> },
    { view: 'runs', label: '运行记录', icon: <Database className="h-4 w-4" /> },
    { view: 'repairs', label: '失败修复', icon: <Wrench className="h-4 w-4" /> },
  ];
  const activeNavItem = navItems.find((item) => item.view === activeView) ?? navItems[0];
  const activeViewMeta: Record<EvalView, EvalViewMeta> = {
    overview: {
      title: '仪表盘',
      badge: `${dashboard.summary.caseCount} 用例`,
      helper: '整体评测状态、运行配置、最新报告和模型趋势。',
    },
    cases: {
      title: '测试用例',
      badge: `${filteredCases.length}/${dashboard.cases.length}`,
      helper: '管理固定问句、预期产物、标签和单用例运行。',
    },
    evalSets: {
      title: '评测集',
      badge: `${filteredEvalSets.length}/${evalSets.length}`,
      helper: '按能力、输入类型和专项场景组织批量回归。',
    },
    evaluator: {
      title: '评测器',
      badge: `${runtimeOptions.length} 个`,
      helper: '研究运行器、命令构造、报告解析和链路 dry-run。',
    },
    queue: {
      title: '运行队列',
      badge: `${dashboard.queue.length} 条`,
      helper: '查看排队、运行中、已完成和可取消的评测任务。',
    },
    runs: {
      title: '运行记录',
      badge: `${dashboard.runs.length} 次`,
      helper: '浏览历史报告、模型表现和版本影响。',
    },
    repairs: {
      title: '失败修复',
      badge: `${dashboard.repairTickets.length} 单`,
      helper: '汇总失败用例、修复单和验证警告。',
    },
  };
  const currentMeta = activeViewMeta[activeView];

  return (
    <EvalConsoleShell
      activeView={activeView}
      navItems={navItems}
      activeNavItem={activeNavItem}
      currentMeta={currentMeta}
      toast={toast}
      isRefreshing={isRefreshing}
      isStarting={isStarting}
      onViewChange={setActiveView}
      onRefresh={refreshDashboard}
      onCheckSchedule={checkScheduleNow}
      onStart={startSelectedEvalSet}
    >

            {activeView === 'overview' && (
              <EvalOverviewView
                dashboard={dashboard}
                latestRun={latestRun}
                delta={delta}
                activeQueueCount={activeQueueCount}
                evalSets={evalSets}
                selectedEvalSetId={selectedEvalSetId}
                limit={limit}
                runtimeOptions={runtimeOptions}
                benchmarkCli={benchmarkCli}
                benchmarkModel={benchmarkModel}
                benchmarkReasoningEffort={benchmarkReasoningEffort}
                benchmarkRuntime={benchmarkRuntime}
                benchmarkRuntimeSupportsReasoning={benchmarkRuntimeSupportsReasoning}
                isStarting={isStarting}
                onSelectedEvalSetChange={selectEvalSet}
                onBenchmarkCliChange={updateBenchmarkCli}
                onBenchmarkModelChange={setBenchmarkModel}
                onBenchmarkReasoningEffortChange={setBenchmarkReasoningEffort}
                onLimitChange={setLimit}
                onStart={startSelectedEvalSet}
              />
            )}

            {activeView === 'cases' && (
              <EvalCasesView
                caseKeyword={caseKeyword}
                selectedCase={selectedCase}
                totalCaseCount={dashboard.cases.length}
                filteredCases={filteredCases}
                selectedEvalSetCases={selectedEvalSetCases}
                latestRun={latestRun}
                latestResultByCase={latestResultByCase}
                isStarting={isStarting}
                onCaseKeywordChange={setCaseKeyword}
                onSelectedCaseChange={setSelectedCase}
                onRunSelection={() => startBenchmark()}
                onRunCase={(caseId) => startBenchmark(caseId)}
              />
            )}

            {activeView === 'evalSets' && (
              <EvalSetsView
                evalSets={evalSets}
                filteredEvalSets={filteredEvalSets}
                pagedEvalSets={pagedEvalSets}
                selectedEvalSet={selectedEvalSet}
                selectedEvalSetStats={selectedEvalSetStats}
                latestResultByCase={latestResultByCase}
                evalSetKeyword={evalSetKeyword}
                evalSetCategoryFilter={evalSetCategoryFilter}
                evalSetCategories={evalSetCategories}
                evalSetPage={evalSetPage}
                evalSetPageCount={evalSetPageCount}
                isStarting={isStarting}
                onEvalSetKeywordChange={setEvalSetKeyword}
                onEvalSetCategoryFilterChange={setEvalSetCategoryFilter}
                onEvalSetSelect={selectEvalSet}
                onEvalSetPageChange={setEvalSetPage}
                onRunSelectedEvalSet={startSelectedEvalSet}
              />
            )}

            {activeView === 'evaluator' && (
              <EvalEvaluatorView
                runtimeOptions={runtimeOptions}
                benchmarkCli={benchmarkCli}
                benchmarkModel={benchmarkModel}
                benchmarkReasoningEffort={benchmarkReasoningEffort}
                benchmarkRuntime={benchmarkRuntime}
                benchmarkRuntimeSupportsReasoning={benchmarkRuntimeSupportsReasoning}
                evalSets={evalSets}
                selectedEvalSetId={selectedEvalSetId}
                selectedEvalSet={selectedEvalSet}
                flowSimulation={flowSimulation}
                isSimulatingFlow={isSimulatingFlow}
                isStarting={isStarting}
                onBenchmarkCliChange={updateBenchmarkCli}
                onBenchmarkModelChange={setBenchmarkModel}
                onBenchmarkReasoningEffortChange={setBenchmarkReasoningEffort}
                onEvalSetSelect={selectEvalSet}
                onSimulateFlow={simulateFlow}
                onStart={startSelectedEvalSet}
              />
            )}

            {activeView === 'queue' && (
              <EvalQueueView
                queue={dashboard.queue}
                schedule={dashboard.schedule}
                cases={dashboard.cases}
                runtimeOptions={runtimeOptions}
                scheduleRuntime={scheduleRuntime}
                scheduleRuntimeSupportsReasoning={scheduleRuntimeSupportsReasoning}
                scheduleEnabled={scheduleEnabled}
                scheduleInterval={scheduleInterval}
                scheduleCli={scheduleCli}
                scheduleModel={scheduleModel}
                scheduleReasoningEffort={scheduleReasoningEffort}
                scheduleCase={scheduleCase}
                isSavingSchedule={isSavingSchedule}
                onCancelBenchmark={cancelBenchmark}
                onScheduleEnabledChange={setScheduleEnabled}
                onScheduleIntervalChange={setScheduleInterval}
                onScheduleCliChange={updateScheduleCli}
                onScheduleModelChange={setScheduleModel}
                onScheduleReasoningEffortChange={setScheduleReasoningEffort}
                onScheduleCaseChange={setScheduleCase}
                onSaveSchedule={saveSchedule}
              />
            )}

            {activeView === 'runs' && (
              <EvalRunsView
                runKeyword={runKeyword}
                filteredRuns={filteredRuns}
                modelComparison={dashboard.modelComparison}
                skillVersionImpact={dashboard.skillVersionImpact}
                onRunKeywordChange={setRunKeyword}
              />
            )}

            {activeView === 'repairs' && (
              <EvalRepairsView repairTickets={dashboard.repairTickets} warningResults={warningResults} latestRun={latestRun} />
            )}
    </EvalConsoleShell>
  );
}
