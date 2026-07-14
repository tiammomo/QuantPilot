"use client";

import { Fragment, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, CircleStop, ListPlus, Loader2, Pause, Play, RefreshCcw, Search, SkipForward, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  StrategyAutoFillIngestionStartResult,
  StrategyDashboardData,
  StrategyHistoryIngestionResult,
  StrategyIngestionJob,
  StrategyUniverse,
  StrategyUniverseMembersPage,
} from "@/lib/quant/strategies";
import { StockKlineDetail } from "./StockKlineDetail";
import {
  type IngestionRangeMode,
  API_BASE,
  INGESTION_BATCH_SIZE,
  INGESTION_LOG_LIMIT,
  addDaysInputValue,
  findLatestAutoFillJob,
  findLatestRunningAutoFillChildJob,
  findLatestUniverseBatchJob,
  formatDateTime,
  formatDuration,
  formatNumberValue,
  formatSignedPercent,
  ingestionBatchRangeLabel,
  ingestionControlJobId,
  ingestionControlLabel,
  ingestionErrorPreview,
  ingestionProgress,
  ingestionRangeLabel,
  ingestionSymbolPreview,
  isEtfUniverse,
  isStaleRunningIngestionJob,
  jobStatusClass,
  jobStatusLabel,
  liquidityLabel,
  liquiditySubLabel,
  numberFromUnknown,
  signedToneClass,
  stringFromUnknown,
  todayInputValue,
  trendClass,
  trendLabel,
  valuationSummary,
} from "./strategy-platform-helpers";

const UNIVERSE_PAGE_SIZE = 10;
const DETAIL_ANIMATION_MS = 260;
function buildUniverseMembersPage(
  universe: StrategyUniverse | null,
  page = 1,
  keyword = ""
): StrategyUniverseMembersPage {
  const total = universe?.memberCount ?? universe?.members.length ?? 0;
  return {
    universeId: universe?.id ?? "",
    page,
    pageSize: UNIVERSE_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / UNIVERSE_PAGE_SIZE)),
    keyword: keyword || null,
    members: universe?.members ?? [],
    fetchedAt: new Date().toISOString(),
  };
}

export function UniverseView({
  data,
  isAdding,
  onAdd,
}: {
  data: StrategyDashboardData;
  isAdding: boolean;
  onAdd: (universeId: string, query: string) => Promise<void>;
}) {
  const initialUniverse =
    data.research.universes.find((universe) => universe.id === data.research.primaryUniverseId) ??
    data.research.universes[0] ??
    null;
  const [memberQuery, setMemberQuery] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedMemberSymbol, setSelectedMemberSymbol] = useState<string | null>(null);
  const [selectedUniverseId, setSelectedUniverseId] = useState(
    initialUniverse?.id ?? data.research.primaryUniverseId
  );
  const [membersPage, setMembersPage] = useState<StrategyUniverseMembersPage>(() =>
    buildUniverseMembersPage(initialUniverse)
  );
  const [memberReloadToken, setMemberReloadToken] = useState(0);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [ingestionJobs, setIngestionJobs] = useState<StrategyIngestionJob[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [isAutoFilling, setIsAutoFilling] = useState(false);
  const [isControllingIngestion, setIsControllingIngestion] = useState(false);
  const [autoFillMessage, setAutoFillMessage] = useState<string | null>(null);
  const [isIngestionDialogOpen, setIsIngestionDialogOpen] = useState(false);
  const [ingestionRangeMode, setIngestionRangeMode] = useState<IngestionRangeMode>("incremental");
  const [ingestionStartDate, setIngestionStartDate] = useState("");
  const [ingestionEndDate, setIngestionEndDate] = useState(() => todayInputValue());
  const [batchOffset, setBatchOffset] = useState(0);
  const [openingMemberSymbol, setOpeningMemberSymbol] = useState<string | null>(null);
  const [closingMemberSymbol, setClosingMemberSymbol] = useState<string | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openFrameRef = useRef<number | null>(null);
  const autoFillPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedUniverse =
    data.research.universes.find((universe) => universe.id === selectedUniverseId) ??
    data.research.universes.find((universe) => universe.id === data.research.primaryUniverseId) ??
    data.research.universes[0] ??
    null;
  const selectedIsEtfUniverse = isEtfUniverse(selectedUniverse);
  const selectedUniverseNoun = selectedIsEtfUniverse ? "ETF/指数" : "股票";

  useEffect(() => {
    if (data.research.universes.some((universe) => universe.id === selectedUniverseId)) return;
    setSelectedUniverseId(data.research.primaryUniverseId);
  }, [data.research.primaryUniverseId, data.research.universes, selectedUniverseId]);

  useEffect(() => {
    setMembersPage(buildUniverseMembersPage(selectedUniverse));
  }, [data.generatedAt, selectedUniverse]);

  const selectedUniverseIdForJobs = selectedUniverse?.id ?? null;

  const loadIngestionJobs = useCallback(async (): Promise<StrategyIngestionJob[]> => {
    if (!selectedUniverseIdForJobs) return [];
    setIsLoadingJobs(true);
    try {
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ingestion-jobs",
          universeId: selectedUniverseIdForJobs,
          limit: 100,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "读取补数任务失败");
      }
      const jobs = (payload.data?.jobs ?? []) as StrategyIngestionJob[];
      setIngestionJobs(jobs);
      const latestJob = findLatestUniverseBatchJob(jobs);
      if (latestJob?.nextOffset !== undefined && latestJob.nextOffset !== null) {
        setBatchOffset(latestJob.nextOffset);
      }
      return jobs;
    } catch {
      setIngestionJobs([]);
      return [];
    } finally {
      setIsLoadingJobs(false);
    }
  }, [selectedUniverseIdForJobs]);

  useEffect(() => {
    void loadIngestionJobs();
  }, [loadIngestionJobs]);

  useEffect(() => {
    if (!selectedUniverse) return;
    const controller = new AbortController();
    const keyword = memberSearch.trim();
    const requestedPage = page;
    setIsLoadingMembers(true);
    setMemberError(null);
    void fetch(`${API_BASE}/api/quant/strategies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "universe-members",
        universeId: selectedUniverse.id,
        page: requestedPage,
        pageSize: UNIVERSE_PAGE_SIZE,
        keyword,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) {
          throw new Error(payload.error ?? "读取股票池分页失败");
        }
        const nextPage = payload.data as StrategyUniverseMembersPage;
        setMembersPage(nextPage);
        if (nextPage.page !== requestedPage) setPage(nextPage.page);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMemberError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingMembers(false);
      });
    return () => controller.abort();
  }, [memberReloadToken, memberSearch, page, selectedUniverse]);

  const members = membersPage.universeId === selectedUniverse?.id ? membersPage.members : [];
  const hasMemberSearch = Boolean(memberSearch.trim());
  const selectedUniverseTotal = selectedUniverse?.memberCount ?? membersPage.total;
  const memberTotal = membersPage.total;
  const totalPages = Math.max(1, membersPage.totalPages);
  const currentPage = Math.min(page, totalPages);
  const pagedMembers = members;
  const latestUniverseBatchJob = findLatestUniverseBatchJob(ingestionJobs);
  const latestAutoFillJob = findLatestAutoFillJob(ingestionJobs);
  const latestAutoFillChildJob = findLatestRunningAutoFillChildJob(ingestionJobs);
  const runningUniverseBatchJob = latestUniverseBatchJob?.status === "running" && !isStaleRunningIngestionJob(latestUniverseBatchJob)
    ? latestUniverseBatchJob
    : null;
  const runningAutoFillJob = latestAutoFillJob?.status === "running" && !isStaleRunningIngestionJob(latestAutoFillJob)
    ? latestAutoFillJob
    : null;
  const runningAutoFillChildJob = latestAutoFillChildJob?.status === "running" && !isStaleRunningIngestionJob(latestAutoFillChildJob)
    ? latestAutoFillChildJob
    : null;
  const controllableIngestionJob = runningAutoFillJob ?? runningAutoFillChildJob ?? latestAutoFillJob ?? latestAutoFillChildJob;
  const controllableIngestionJobId = ingestionControlJobId(controllableIngestionJob);
  const hasControllableIngestionJob = Boolean(controllableIngestionJobId);
  const hasRunningBatchJob = Boolean(runningUniverseBatchJob);
  const hasRunningAutoFillJob = Boolean(runningAutoFillJob || runningAutoFillChildJob);
  const visibleIngestionJobs = ingestionJobs.slice(0, INGESTION_LOG_LIMIT);
  const recentRowsUpserted = visibleIngestionJobs.reduce((sum, job) => sum + job.rowsUpserted, 0);
  const activeJob = controllableIngestionJob ?? latestUniverseBatchJob;
  const activeProgress = ingestionProgress(activeJob, visibleIngestionJobs);
  const activeControl = activeProgress.control;
  const isIngestionBusy = isRunningBatch || isAutoFilling || hasRunningBatchJob || hasRunningAutoFillJob;
  const latestDataDate = selectedUniverse?.latestTs?.slice(0, 10) ?? members.find((member) => member.lastTs)?.lastTs?.slice(0, 10) ?? "";
  const incrementalStartDate = latestDataDate ? addDaysInputValue(latestDataDate, 1) : "";
  const canRunIncrementalIngestion = ingestionRangeMode !== "incremental" || !incrementalStartDate || !ingestionEndDate || incrementalStartDate <= ingestionEndDate;
  const selectedIngestionStart = ingestionRangeMode === "custom"
    ? ingestionStartDate
    : ingestionRangeMode === "incremental"
      ? incrementalStartDate
      : "";
  const selectedIngestionEnd = ingestionRangeMode === "custom" || ingestionRangeMode === "incremental"
    ? ingestionEndDate
    : "";
  const effectiveIngestionEndLabel = selectedIngestionEnd || "最新交易日";
  const selectedRangeLabel = ingestionRangeMode === "lookback"
    ? "近 5 年"
    : `${selectedIngestionStart || "默认起点"} 至 ${effectiveIngestionEndLabel}`;
  const activeRangeLabel = ingestionRangeLabel(activeJob);

  const addMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedUniverse || !memberQuery.trim()) return;
    await onAdd(selectedUniverse.id, memberQuery.trim());
    setMemberQuery("");
    setMemberSearch("");
    setPage(1);
    setMemberReloadToken((value) => value + 1);
  };

  const ingestionRequestRange = useCallback(() => {
    const start = selectedIngestionStart.trim();
    const end = selectedIngestionEnd.trim();
    return {
      start: start || undefined,
      end: end || undefined,
    };
  }, [selectedIngestionEnd, selectedIngestionStart]);

  const runIngestionBatchAt = useCallback(async (offset: number) => {
    if (!selectedUniverse) throw new Error("未选择补数池");
    const range = ingestionRequestRange();
    const response = await fetch(`${API_BASE}/api/quant/strategies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "run-ingestion-batch",
        universeId: selectedUniverse.id,
        offset,
        batchSize: INGESTION_BATCH_SIZE,
        limit: 1260,
        lookbackYears: 5,
        start: range.start,
        end: range.end,
        period: selectedUniverse.defaultTimeframe || "daily",
        adjustment: selectedUniverse.defaultAdjustment || "qfq",
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      throw new Error(payload.error ?? "运行补数批次失败");
    }
    const result = payload.data as StrategyHistoryIngestionResult;
    setBatchOffset(result.next_offset ?? 0);
    await loadIngestionJobs();
    setMemberReloadToken((value) => value + 1);
    return result;
  }, [ingestionRequestRange, loadIngestionJobs, selectedUniverse]);

  const runIngestionBatch = async () => {
    if (!selectedUniverse || isRunningBatch || isAutoFilling) return;
    if (!canRunIncrementalIngestion) {
      setMemberError("当前数据已覆盖到所选结束日期，无需增量补数。");
      return;
    }
    if (hasRunningBatchJob || hasRunningAutoFillJob) {
      setMemberError("已有补数任务正在运行，完成后再补下一批。");
      return;
    }
    setIsRunningBatch(true);
    setMemberError(null);
    try {
      await runIngestionBatchAt(batchOffset);
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunningBatch(false);
    }
  };

  const stopAutoFillPolling = () => {
    if (autoFillPollRef.current) {
      clearInterval(autoFillPollRef.current);
      autoFillPollRef.current = null;
    }
  };

  const runIngestionAutoFill = async () => {
    if (!selectedUniverse || isAutoFilling || isRunningBatch) return;
    if (!canRunIncrementalIngestion) {
      setMemberError("当前数据已覆盖到所选结束日期，无需增量补数。");
      return;
    }
    const range = ingestionRequestRange();
    setIsAutoFilling(true);
    setMemberError(null);
    setAutoFillMessage("正在提交后端自动补齐任务...");
    try {
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start-ingestion-autofill",
          universeId: selectedUniverse.id,
          offset: batchOffset,
          batchSize: INGESTION_BATCH_SIZE,
          limit: 1260,
          lookbackYears: 5,
          start: range.start,
          end: range.end,
          period: selectedUniverse.defaultTimeframe || "daily",
          adjustment: selectedUniverse.defaultAdjustment || "qfq",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "启动后端自动补齐失败");
      }
      const result = payload.data as StrategyAutoFillIngestionStartResult;
      setBatchOffset(result.next_offset ?? batchOffset);
      setAutoFillMessage(`后端自动补齐已启动 · ${result.job_id}`);
      await loadIngestionJobs();
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : String(error));
      setAutoFillMessage(null);
    }
  };

  const controlIngestion = async (control: "pause" | "resume" | "stop") => {
    const jobId = controllableIngestionJobId;
    if (!jobId || !hasRunningAutoFillJob || isControllingIngestion) return;
    setIsControllingIngestion(true);
    setMemberError(null);
    const label = control === "pause" ? "暂停" : control === "resume" ? "继续" : "停止";
    try {
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "control-ingestion-job",
          jobId,
          control,
          reason: `${label}策略平台自动补数`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? `${label}补数任务失败`);
      }
      setAutoFillMessage(
        control === "pause"
          ? "已请求暂停，当前标的处理完后会挂起。"
          : control === "resume"
            ? "已请求继续，后端将从当前 offset 恢复。"
            : "已请求停止，当前标的处理完后会安全收尾。"
      );
      await loadIngestionJobs();
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsControllingIngestion(false);
    }
  };

  useEffect(() => {
    const running = hasRunningAutoFillJob || isAutoFilling;
    if (!running) {
      stopAutoFillPolling();
      if (hasControllableIngestionJob && isAutoFilling) {
        setIsAutoFilling(false);
      }
      return;
    }
    stopAutoFillPolling();
    void loadIngestionJobs();
    autoFillPollRef.current = setInterval(() => {
      void loadIngestionJobs().then((jobs) => {
        const parentJob = findLatestAutoFillJob(jobs);
        const autoFillJob = parentJob && !isStaleRunningIngestionJob(parentJob)
          ? parentJob
          : findLatestRunningAutoFillChildJob(jobs);
        if (!autoFillJob) {
          setIsAutoFilling(false);
          stopAutoFillPolling();
          return;
        }
        const completedBatches = numberFromUnknown(autoFillJob.metadata.completed_batches) ?? 0;
        const maxBatches = numberFromUnknown(autoFillJob.metadata.max_batches);
        const nextOffset = autoFillJob.nextOffset ?? 0;
        setAutoFillMessage(
          autoFillJob.status === "running"
            ? `后端自动补齐中 · ${completedBatches}${maxBatches ? `/${maxBatches}` : ""} 批 · 下批 ${nextOffset}`
            : `后端自动补齐${jobStatusLabel(autoFillJob.status)} · 下批 ${nextOffset}`
        );
        if (autoFillJob.status !== "running" || isStaleRunningIngestionJob(autoFillJob)) {
          setIsAutoFilling(false);
          setMemberReloadToken((value) => value + 1);
          stopAutoFillPolling();
        }
      });
    }, 2000);
    return stopAutoFillPolling;
  }, [hasControllableIngestionJob, hasRunningAutoFillJob, isAutoFilling, loadIngestionJobs]);

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const clearOpenFrame = () => {
    if (openFrameRef.current !== null) {
      cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }
  };

  const finishOpeningOnNextFrame = (symbol: string) => {
    openFrameRef.current = requestAnimationFrame(() => {
      openFrameRef.current = requestAnimationFrame(() => {
        setOpeningMemberSymbol((current) => (current === symbol ? null : current));
        openFrameRef.current = null;
      });
    });
  };

  const scheduleCloseRemoval = (symbol: string) => {
    setClosingMemberSymbol(symbol);
    closeTimerRef.current = setTimeout(() => {
      setClosingMemberSymbol((current) => (current === symbol ? null : current));
      closeTimerRef.current = null;
    }, DETAIL_ANIMATION_MS);
  };

  const closeMemberDetail = (symbol: string) => {
    clearCloseTimer();
    clearOpenFrame();
    setOpeningMemberSymbol(null);
    setSelectedMemberSymbol(null);
    scheduleCloseRemoval(symbol);
  };

  const toggleMemberDetail = (symbol: string) => {
    if (selectedMemberSymbol === symbol) {
      closeMemberDetail(symbol);
      return;
    }
    const previousSymbol = selectedMemberSymbol;
    clearCloseTimer();
    clearOpenFrame();
    setOpeningMemberSymbol(symbol);
    setSelectedMemberSymbol(symbol);
    setClosingMemberSymbol(null);
    if (previousSymbol && previousSymbol !== symbol) {
      scheduleCloseRemoval(previousSymbol);
    }
    finishOpeningOnNextFrame(symbol);
  };

  useEffect(
    () => () => {
      clearCloseTimer();
      clearOpenFrame();
    },
    []
  );

  return (
    <div className="space-y-5">
      {data.research.error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          市场数据服务暂不可用，当前展示本地兜底配置：{data.research.error}
        </div>
      )}

      {selectedUniverse && (
        <section className="rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-slate-950">{selectedUniverse.name}</h2>
                <Badge variant="outline" className="bg-white text-slate-500">
                  {hasMemberSearch ? `${memberTotal} / ${selectedUniverseTotal} 只` : `${selectedUniverseTotal} 只`}
                </Badge>
                {isLoadingMembers && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                一张可检索、可分页的{selectedUniverseNoun}列表；点击任意标的查看 K 线、覆盖统计和主数据。
              </p>
            </div>
            <form onSubmit={addMember} className="flex min-w-[280px] flex-1 flex-wrap justify-end gap-2">
              <Input
                value={memberQuery}
                onChange={(event) => setMemberQuery(event.target.value)}
                aria-label={`添加${selectedUniverseNoun}标的`}
                placeholder="输入代码或名称，例如 比亚迪 / 000001"
                className="h-9 max-w-sm border-slate-200 bg-white"
              />
              <Button type="submit" size="sm" disabled={isAdding || !memberQuery.trim()} className="bg-blue-600 text-white hover:bg-blue-700">
                {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListPlus className="h-4 w-4" />}
                加入{selectedUniverseNoun}池
              </Button>
            </form>
          </div>
          <Dialog.Root
            open={isIngestionDialogOpen}
            onOpenChange={(open) => {
              setIsIngestionDialogOpen(open);
              if (open) void loadIngestionJobs();
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
              {data.research.universes.length > 1 ? (
                <div className="flex flex-wrap gap-2">
                  {data.research.universes.map((universe) => (
                    <button
                      key={universe.id}
                      type="button"
                      onClick={() => {
                        setSelectedUniverseId(universe.id);
                        setMemberSearch("");
                        setPage(1);
                        setSelectedMemberSymbol(null);
                        setOpeningMemberSymbol(null);
                        setClosingMemberSymbol(null);
                        setMemberError(null);
                        setMembersPage(buildUniverseMembersPage(universe));
                      }}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                        selectedUniverse.id === universe.id
                          ? "border-blue-200 bg-blue-50 text-blue-700"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                      )}
                    >
                      {universe.name}
                      <span className="ml-1.5 text-xs text-slate-400">{universe.memberCount}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div />
              )}
              <Dialog.Trigger asChild>
                <Button type="button" variant="outline" size="sm" className="border-slate-200 bg-white">
                    {isRunningBatch || isAutoFilling || hasRunningBatchJob || hasRunningAutoFillJob ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCcw className="h-4 w-4" />
                    )}
                    补数
                    {activeJob && (
                      <span
                        className={cn(
                          "ml-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                          jobStatusClass(activeProgress.isStale ? "partial" : activeJob.status)
                        )}
                      >
                        {activeProgress.isStale ? "心跳过期" : jobStatusLabel(activeJob.status)}
                      </span>
                    )}
                </Button>
              </Dialog.Trigger>
            </div>
                <Dialog.Portal>
                  <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
                  <Dialog.Content className="fixed left-[50%] top-[50%] z-50 max-h-[86vh] w-[min(1120px,calc(100vw-32px))] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
                    <div className="flex max-h-[86vh] flex-col">
                      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
                        <div>
                          <Dialog.Title className="text-lg font-semibold text-slate-950">低频补数</Dialog.Title>
                          <Dialog.Description className="mt-1 text-sm text-slate-500">
                            选择补数范围后分批补充成交额、换手率、停牌/ST 和涨跌停字段；估值因子后续单独补，避免拖慢日常增量补数。
                          </Dialog.Description>
                        </div>
                        <div className="flex items-center gap-2">
                          {isLoadingJobs && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
                          {activeJob && (
                            <Badge
                              variant="outline"
                              className={jobStatusClass(activeProgress.isStale ? "partial" : activeJob.status)}
                            >
                              {activeProgress.isStale ? "心跳过期" : jobStatusLabel(activeJob.status)}
                            </Badge>
                          )}
                          <Dialog.Close className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
                            <X className="h-5 w-5" />
                          </Dialog.Close>
                        </div>
                      </div>
                      <div className="flex-1 overflow-y-auto p-5">
                        <div className="space-y-4">
                          <div className="rounded-md border border-slate-200 bg-white">
                            <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-4">
                              <div>
                                <p className="text-sm font-semibold text-slate-900">更新进度</p>
                                <p className="mt-1 text-xs text-slate-500">
                                  范围：{activeJob?.status === "running" ? activeRangeLabel : selectedRangeLabel}
                                </p>
                              </div>
                              <div className="grid grid-cols-2 gap-4 text-right text-xs text-slate-500 md:grid-cols-4">
                                <div>
                                  <p>完成标的</p>
                                  <p className="mt-1 font-mono text-base font-semibold text-slate-950">
                                    {activeProgress.completedSymbols}/{activeProgress.totalSymbols || selectedUniverseTotal}
                                  </p>
                                </div>
                                <div>
                                  <p>入库行数</p>
                                  <p className="mt-1 font-mono text-base font-semibold text-slate-950">
                                    {activeJob?.rowsUpserted.toLocaleString("zh-CN") ?? recentRowsUpserted.toLocaleString("zh-CN")}
                                  </p>
                                </div>
                                <div>
                                  <p>预计剩余</p>
                                  <p className="mt-1 font-mono text-base font-semibold text-slate-950">{formatDuration(activeProgress.etaSeconds)}</p>
                                </div>
                                <div>
                                  <p>预计完成</p>
                                  <p className="mt-1 font-mono text-base font-semibold text-slate-950">
                                    {activeProgress.etaSeconds !== null
                                      ? formatDateTime(new Date(Date.now() + activeProgress.etaSeconds * 1000).toISOString())
                                      : "-"}
                                  </p>
                                </div>
                              </div>
                            </div>
                            <div className="px-4 pb-4">
                              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="h-full rounded-full bg-blue-600 transition-all"
                                  style={{ width: `${activeProgress.percent}%` }}
                                />
                              </div>
                              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                                <span>
                                  当前标的 {activeProgress.currentSymbol ?? "-"} · {activeProgress.isStale ? "心跳过期，等待收口" : ingestionControlLabel(activeControl)}
                                  {activeProgress.preflightSkippedSymbols ? ` · 本地跳过 ${activeProgress.preflightSkippedSymbols}` : ""}
                                </span>
                                <span>心跳 {formatDateTime(activeProgress.lastHeartbeatAt)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-4 py-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-slate-900">补数范围</p>
                                <p className="mt-1 text-xs text-slate-500">默认按本地最新交易日向后补；也可以手动指定完整日期范围。</p>
                              </div>
                              <div className="flex rounded-md border border-slate-200 bg-white p-1">
                                {[
                                  ["incremental", "增量"] as const,
                                  ["lookback", "近5年"] as const,
                                  ["custom", "自定义"] as const,
                                ].map(([mode, label]) => (
                                  <button
                                    key={mode}
                                    type="button"
                                    onClick={() => setIngestionRangeMode(mode)}
                                    className={cn(
                                      "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                                      ingestionRangeMode === mode ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-50"
                                    )}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="mt-4 grid gap-3 md:grid-cols-3">
                              <label className="text-xs text-slate-500">
                                开始日期
                                <Input
                                  type="date"
                                  value={selectedIngestionStart}
                                  onChange={(event) => {
                                    setIngestionRangeMode("custom");
                                    setIngestionStartDate(event.target.value);
                                  }}
                                  disabled={ingestionRangeMode !== "custom"}
                                  className="mt-1 h-9 border-slate-200 bg-white"
                                />
                              </label>
                              <label className="text-xs text-slate-500">
                                结束日期
                                <Input
                                  type="date"
                                  value={selectedIngestionEnd}
                                  onChange={(event) => setIngestionEndDate(event.target.value)}
                                  disabled={ingestionRangeMode === "lookback"}
                                  className="mt-1 h-9 border-slate-200 bg-white"
                                />
                              </label>
                              <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                                <p>当前范围</p>
                                <p className="mt-1 font-mono text-sm font-semibold text-slate-900">{selectedRangeLabel}</p>
                              </div>
                            </div>
                            {!canRunIncrementalIngestion && (
                              <p className="mt-2 text-xs text-emerald-600">当前本地数据已覆盖到所选结束日期，无需增量补数。</p>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-4 py-3">
                            <div>
                              <p className="text-sm font-semibold text-slate-900">执行控制</p>
                              {(autoFillMessage || isIngestionBusy) && (
                                <p className="mt-1 text-xs text-blue-600">
                                  {autoFillMessage ??
                                    (controllableIngestionJobId
                                      ? `已有补数任务运行中，可暂停或停止。任务 ${controllableIngestionJobId}`
                                      : "已有补数任务运行中，等待完成后可继续。")}
                                </p>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button variant="outline" size="sm" onClick={() => void loadIngestionJobs()} disabled={isLoadingJobs}>
                                <RefreshCcw className={cn("h-4 w-4", isLoadingJobs && "animate-spin")} />
                                刷新进度
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={runIngestionBatch}
                                disabled={isIngestionBusy || !canRunIncrementalIngestion}
                              >
                                {isRunningBatch ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                                补下一批
                              </Button>
                              {isAutoFilling || hasRunningAutoFillJob ? (
                                <>
                                  {activeControl === "pause" ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => void controlIngestion("resume")}
                                      disabled={isControllingIngestion}
                                    >
                                      {isControllingIngestion ? <Loader2 className="h-4 w-4 animate-spin" /> : <SkipForward className="h-4 w-4" />}
                                      继续
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => void controlIngestion("pause")}
                                      disabled={isControllingIngestion || activeControl === "stop"}
                                    >
                                      {isControllingIngestion ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                                      暂停
                                    </Button>
                                  )}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void controlIngestion("stop")}
                                    disabled={isControllingIngestion || activeControl === "stop"}
                                    className="border-red-200 text-red-700 hover:bg-red-50"
                                  >
                                    <CircleStop className="h-4 w-4" />
                                    停止
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  size="sm"
                                  onClick={runIngestionAutoFill}
                                  disabled={isIngestionBusy || !canRunIncrementalIngestion}
                                  className="bg-blue-600 text-white hover:bg-blue-700"
                                >
                                  <Play className="h-4 w-4" />
                                  一键补齐
                                </Button>
                              )}
                            </div>
                          </div>
                <div className="border-t border-slate-200 bg-white px-4 py-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-900">最近批次</p>
                    <span className="text-xs text-slate-500">近 {INGESTION_LOG_LIMIT} 批 · 入库 {recentRowsUpserted.toLocaleString("zh-CN")} 行</span>
                  </div>
                  {visibleIngestionJobs.length ? (
                    <div className="overflow-x-auto rounded-md border border-slate-200">
                      <table className="w-full min-w-[980px] text-left text-xs">
                        <thead className="bg-slate-50 text-slate-500">
                          <tr>
	                            <th className="px-3 py-2 font-medium">状态</th>
	                            <th className="px-3 py-2 font-medium">批次</th>
	                            <th className="px-3 py-2 font-medium">范围</th>
	                            <th className="px-3 py-2 font-medium">标的</th>
	                            <th className="px-3 py-2 font-medium">入库</th>
                            <th className="px-3 py-2 font-medium">时间</th>
                            <th className="px-3 py-2 font-medium">样本 / 错误</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {visibleIngestionJobs.map((job) => {
                            const errorPreview = ingestionErrorPreview(job);
                            return (
                              <tr key={job.id} className="align-top">
                                <td className="px-3 py-3">
                                  <Badge variant="outline" className={jobStatusClass(job.status)}>
                                    {jobStatusLabel(job.status)}
                                  </Badge>
                                </td>
	                                <td className="px-3 py-3">
	                                  <p className="font-mono font-semibold text-slate-900">{ingestionBatchRangeLabel(job)}</p>
	                                </td>
	                                <td className="px-3 py-3 font-mono text-slate-600">
	                                  {ingestionRangeLabel(job)}
	                                </td>
                                  <td className="px-3 py-3">
                                    <p className="font-mono font-semibold text-slate-900">
                                      {job.completedSymbols}/{job.totalSymbols}
                                    </p>
                                    <p className={cn("mt-1", job.failedSymbols ? "text-red-600" : "text-slate-400")}>
                                      {job.failedSymbols ? `${job.failedSymbols} 失败` : "无失败"}
                                    </p>
                                    {job.provider === "baostock-autofill" && (
                                      <p className="mt-1 text-slate-400">
                                        {ingestionControlLabel(stringFromUnknown(job.metadata.control))}
                                      </p>
                                    )}
                                  </td>
                                  <td className="px-3 py-3">
                                    <p className="font-mono font-semibold text-slate-900">
                                      {job.rowsUpserted.toLocaleString("zh-CN")} 行
                                    </p>
                                    <p className="mt-1 text-slate-400">
                                      收到 {job.rowsReceived.toLocaleString("zh-CN")}
                                    </p>
                                    {numberFromUnknown(job.metadata.preflight_skipped_symbols) ? (
                                      <p className="mt-1 text-emerald-600">
                                        本地跳过 {numberFromUnknown(job.metadata.preflight_skipped_symbols)}
                                      </p>
                                    ) : null}
                                  </td>
                                <td className="px-3 py-3">
                                  <p className="font-mono text-slate-700">{formatDateTime(job.startedAt ?? job.createdAt)}</p>
                                  <p className="mt-1 font-mono text-slate-400">{formatDateTime(job.completedAt ?? job.updatedAt)}</p>
                                </td>
                                <td className="px-3 py-3">
                                  <p className="line-clamp-2 text-slate-600">{ingestionSymbolPreview(job)}</p>
                                  {errorPreview && (
                                    <p className="mt-1 line-clamp-2 text-red-600">{errorPreview}</p>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
                      暂无补数日志
                    </div>
                  )}
                </div>
                        </div>
                      </div>
                    </div>
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
            <div className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={memberSearch}
                onChange={(event) => {
                  setMemberSearch(event.target.value);
                  setPage(1);
                  setSelectedMemberSymbol(null);
                }}
                aria-label={`筛选${selectedUniverseNoun}成员`}
                placeholder="筛选名称、代码、板块、交易所..."
                className="h-9 border-slate-200 bg-white pl-9"
              />
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span>第 {currentPage} / {totalPages} 页</span>
              <Button aria-label="上一页" title="上一页" variant="outline" size="sm" onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1 || isLoadingMembers}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button aria-label="下一页" title="下一页" variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage >= totalPages || isLoadingMembers}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {memberError && (
            <div className="border-b border-amber-100 bg-amber-50 px-5 py-2 text-sm text-amber-700">
              {memberError}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1300px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="w-[10%] px-5 py-3 font-medium">标的名称</th>
                  <th className="w-[8%] px-3 py-3 font-medium">代码</th>
                  <th className="w-[18%] px-3 py-3 font-medium">所属板块</th>
                  <th className="w-[10%] px-3 py-3 font-medium">行情</th>
                  <th className="w-[12%] px-3 py-3 font-medium">强弱</th>
                  <th className="w-[12%] px-3 py-3 font-medium">趋势</th>
                  <th className="w-[16%] px-3 py-3 font-medium">流动性</th>
                  <th className="w-[14%] px-3 py-3 font-medium">估值</th>
                </tr>
              </thead>
              <tbody>
                {pagedMembers.map((member) => {
                  const isDetailSelected = selectedMemberSymbol === member.symbol;
                  const isDetailOpen = isDetailSelected && openingMemberSymbol !== member.symbol;
                  const isDetailClosing = closingMemberSymbol === member.symbol;
                  const shouldRenderDetail = isDetailSelected || isDetailClosing;
                  const displaySectorTags = member.sectorTags.length
                    ? member.sectorTags
                    : selectedIsEtfUniverse
                      ? [member.assetType.toUpperCase()]
                      : [];

                  return (
                    <Fragment key={member.symbol}>
                      <tr
                        aria-expanded={isDetailSelected}
                        onClick={() => toggleMemberDetail(member.symbol)}
                        className={cn(
                          "cursor-pointer border-t border-slate-100 transition-colors hover:bg-slate-50",
                          shouldRenderDetail && "bg-blue-50/60"
                        )}
                      >
                        <td className="px-5 py-3 font-medium text-slate-950">{member.name ?? member.symbol}</td>
                        <td className="px-3 py-3">
                          <span className="font-mono text-xs text-slate-700">{member.symbol}</span>
                        </td>
                        <td className="px-3 py-3">
                          {displaySectorTags.length ? (
                            <div className="flex flex-wrap gap-1.5">
                              {displaySectorTags.map((tag, tagIndex) => (
                                <Badge key={`${tag}-${tagIndex}`} variant="outline" className="border-blue-100 bg-blue-50 text-blue-700">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="space-y-0.5">
                            <p className="font-semibold tabular-nums text-slate-950">{formatNumberValue(member.latestClose)}</p>
                            <p className={cn("text-xs font-medium tabular-nums", signedToneClass(member.latestChangePct))}>
                              {formatSignedPercent(member.latestChangePct)}
                            </p>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="space-y-1 text-xs tabular-nums">
                            <p>
                              <span className="text-slate-400">20日 </span>
                              <span className={cn("font-semibold", signedToneClass(member.strength20dPct))}>
                                {formatSignedPercent(member.strength20dPct)}
                              </span>
                            </p>
                            <p>
                              <span className="text-slate-400">60日 </span>
                              <span className={cn("font-semibold", signedToneClass(member.strength60dPct))}>
                                {formatSignedPercent(member.strength60dPct)}
                              </span>
                            </p>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="space-y-1">
                            <Badge variant="outline" className={trendClass(member.trendStatus)}>
                              {trendLabel(member.trendStatus)}
                            </Badge>
                            <div className="space-y-0.5 text-xs tabular-nums text-slate-400">
                              <p>MA20 {formatNumberValue(member.ma20)}</p>
                              <p>MA60 {formatNumberValue(member.ma60)}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="space-y-0.5">
                            <p className="font-semibold tabular-nums text-slate-950">{liquidityLabel(member)}</p>
                            <p className="text-xs text-slate-400">{liquiditySubLabel(member)}</p>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <p className="text-xs font-semibold tabular-nums text-slate-700">{valuationSummary(member)}</p>
                        </td>
                      </tr>
                      {shouldRenderDetail && (
                        <tr key={`${member.symbol}-detail`} className="border-t border-slate-100">
                          <td colSpan={8} className="p-0">
                            <div
                              className={cn(
                                "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
                                isDetailOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                              )}
                            >
                              <div
                                className={cn(
                                  "overflow-hidden transition-transform duration-300 ease-out",
                                  isDetailOpen ? "translate-y-0 scale-100" : "-translate-y-2 scale-[0.985]"
                                )}
                              >
                                <StockKlineDetail
                                  member={member}
                                  universe={selectedUniverse}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {!pagedMembers.length && (
                  <tr className="border-t border-slate-100">
                    <td colSpan={8} className="px-5 py-12 text-center text-sm text-slate-500">
                      {isLoadingMembers ? "正在读取股票池..." : "没有匹配的股票"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
