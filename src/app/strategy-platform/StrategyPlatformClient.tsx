"use client";

import { Fragment, type FormEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  CircleStop,
  DatabaseZap,
  GitBranch,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
  Search,
  ShieldCheck,
  SkipForward,
  SquareStack,
  TrendingUp,
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
import { SubNav, type SubNavItem } from "@/components/layout/SubNav";
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

type Props = { initialData: StrategyDashboardData };
type StrategyView =
  | "universe"
  | "catalog"
  | "factors"
  | "sectorFlow"
  | "foundation"
  | "knowledge"
  | "scans"
  | "compare";
type IngestionRangeMode = "incremental" | "lookback" | "custom";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const INGESTION_BATCH_SIZE = 25;
const INGESTION_LOG_LIMIT = 20;
const INGESTION_STALE_HEARTBEAT_MS = 15 * 60 * 1000;
const INGESTION_STOP_GRACE_MS = 60 * 1000;

// ─── Status helpers ────────────────────────────────────────────
function statusLabel(s: StrategyCatalogItem["status"]) {
  return s === "ready" ? "可执行" : s === "research" ? "需补数据" : "规划中";
}
function statusClass(s: StrategyCatalogItem["status"]) {
  if (s === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (s === "research") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}
function scanStatusClass(s: StrategyCatalogItem["parameterScans"][number]["status"]) {
  if (s === "available") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (s === "planned") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-red-200 bg-red-50 text-red-700";
}
function scanStatusLabel(s: StrategyCatalogItem["parameterScans"][number]["status"]) {
  if (s === "available") return "可执行";
  if (s === "planned") return "规划中";
  return "阻断";
}
function riskClass(level: StrategyCatalogItem["readiness"]["riskLevel"]) {
  if (level === "low") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (level === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-red-200 bg-red-50 text-red-700";
}
function strategyKindLabel(kind?: StrategyCatalogItem["kind"]) {
  if (kind === "stock_selection") return "选股";
  if (kind === "trade_price") return "买卖价格";
  return "策略";
}
function strategyKindClass(kind?: StrategyCatalogItem["kind"]) {
  if (kind === "stock_selection") return "border-blue-200 bg-blue-50 text-blue-700";
  if (kind === "trade_price") return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}
function ruleStatusClass(status?: "ready" | "needs_data" | "manual") {
  if (status === "needs_data") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "manual") return "border-slate-200 bg-slate-50 text-slate-600";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}
function ruleStatusLabel(status?: "ready" | "needs_data" | "manual") {
  if (status === "needs_data") return "缺数据";
  if (status === "manual") return "人工确认";
  return "已具备";
}
function previewRules(strategy: StrategyCatalogItem) {
  const rules = strategy.kind === "trade_price"
    ? [...(strategy.entryRules ?? []), ...(strategy.exitRules ?? [])]
    : strategy.selectionRules ?? [];
  return rules.slice(0, 3);
}
function dataStatusText(strategy: StrategyCatalogItem) {
  const missing = strategy.dataReadiness?.missing.length ?? 0;
  if (missing > 0) return `缺 ${missing} 项`;
  return "数据可用";
}
function formatMetric(value?: number | null, suffix = "") {
  if (value === null || value === undefined) return "-";
  return `${Number(value).toFixed(2)}${suffix}`;
}

function formatDataDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}`;
}

function formatIntradayTime(value?: string | null) {
  if (!value) return "-";
  const match = /(\d{2}):(\d{2})/.exec(value);
  if (match) return `${match[1]}:${match[2]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.hour}:${partMap.minute}`;
}

function todayInputValue() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDaysInputValue(value: string, days: number) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatDuration(seconds?: number | null) {
  const total = finiteNumber(seconds);
  if (total === null || total < 0) return "-";
  const rounded = Math.round(total);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) return `${hours}时${minutes}分`;
  if (minutes > 0) return `${minutes}分${secs}秒`;
  return `${secs}秒`;
}

function timestampMs(value?: string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function finiteNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNumberValue(value?: number | null, digits = 2) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatSignedNumberValue(value?: number | null, digits = 2) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return `${number >= 0 ? "+" : ""}${formatNumberValue(number, digits)}`;
}

function formatLargeValue(value?: number | null, digits = 2) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  const abs = Math.abs(number);
  if (abs >= 100000000) return `${formatNumberValue(number / 100000000, digits)} 亿`;
  if (abs >= 10000) return `${formatNumberValue(number / 10000, digits)} 万`;
  return formatNumberValue(number, digits);
}

function formatSignedPercent(value?: number | null) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatPercentValue(value?: number | null) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return `${number.toFixed(2)}%`;
}

function signedToneClass(value?: number | null) {
  const number = finiteNumber(value);
  if (number === null) return "text-slate-900";
  return number >= 0 ? "text-red-600" : "text-emerald-600";
}

function trendLabel(status: StrategyUniverseMember["trendStatus"]) {
  if (status === "bullish") return "多头";
  if (status === "bearish") return "空头";
  if (status === "sideways") return "震荡";
  return "不足";
}

function trendClass(status: StrategyUniverseMember["trendStatus"]) {
  if (status === "bullish") return "border-red-200 bg-red-50 text-red-700";
  if (status === "bearish") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "sideways") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-500";
}

function liquidityLabel(member: StrategyUniverseMember) {
  if (finiteNumber(member.avgAmount20d) !== null) return formatLargeValue(member.avgAmount20d, 1);
  if (finiteNumber(member.avgVolume20d) !== null) return formatLargeValue(member.avgVolume20d, 1);
  return "-";
}

function liquiditySubLabel(member: StrategyUniverseMember) {
  if (finiteNumber(member.avgAmount20d) !== null && finiteNumber(member.avgTurnover20d) !== null) {
    return `20日均额 · 换手 ${formatPercentValue(member.avgTurnover20d)}`;
  }
  if (finiteNumber(member.avgAmount20d) !== null) return "20日均额";
  if (finiteNumber(member.avgTurnover20d) !== null) return `20日换手 ${formatPercentValue(member.avgTurnover20d)}`;
  if (finiteNumber(member.avgVolume20d) !== null) return "20日均量";
  return "暂无";
}

function valuationSummary(member: StrategyUniverseMember) {
  const pe = finiteNumber(member.peTtm);
  const pb = finiteNumber(member.pbMrq);
  if (pe === null && pb === null) return "-";
  return [
    pe !== null ? `PE ${formatNumberValue(pe, 1)}` : null,
    pb !== null ? `PB ${formatNumberValue(pb, 1)}` : null,
  ].filter(Boolean).join(" / ");
}

function tradeStatusLabel(member: StrategyUniverseMember) {
  if (member.limitUp) return "涨停";
  if (member.limitDown) return "跌停";
  if (member.tradeStatus && member.tradeStatus !== "1") return "停牌";
  if (member.isSt) return "ST";
  return "正常";
}

function tradeStatusClass(member: StrategyUniverseMember) {
  if (member.limitUp) return "border-red-200 bg-red-50 text-red-700";
  if (member.limitDown) return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (member.tradeStatus && member.tradeStatus !== "1") return "border-amber-200 bg-amber-50 text-amber-700";
  if (member.isSt) return "border-orange-200 bg-orange-50 text-orange-700";
  return "border-slate-200 bg-slate-50 text-slate-500";
}

function isEtfUniverse(universe?: StrategyUniverse | null) {
  if (!universe) return false;
  return universe.id === "etf-index-pool" || universe.etfCount + universe.indexCount > universe.stockCount;
}

function jobStatusLabel(status: string) {
  if (status === "completed") return "已完成";
  if (status === "partial") return "部分完成";
  if (status === "failed") return "失败";
  if (status === "running") return "运行中";
  if (status === "queued") return "排队中";
  return status || "-";
}

function jobStatusClass(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  return "border-blue-200 bg-blue-50 text-blue-700";
}

function ingestionControlLabel(control?: string | null) {
  if (control === "pause") return "暂停中";
  if (control === "stop") return "停止中";
  if (control === "resume" || control === "run") return "运行";
  if (control === "idle") return "空闲";
  return "-";
}

function ingestionRangeLabel(job?: StrategyIngestionJob | null) {
  if (!job) return "-";
  const start = stringFromUnknown(job.metadata.effective_start) ?? stringFromUnknown(job.metadata.start);
  const end = stringFromUnknown(job.metadata.end);
  if (!start && (!end || end === "20500101")) return "近 5 年";
  return `${start ?? "默认"} 至 ${end && end !== "20500101" ? end : "最新交易日"}`;
}

function findLatestUniverseBatchJob(jobs: StrategyIngestionJob[]) {
  return jobs.find((job) => job.provider !== "baostock-autofill" && (job.universeTotalSymbols ?? 0) > 1) ?? null;
}

function findLatestAutoFillJob(jobs: StrategyIngestionJob[]) {
  return jobs.find((job) => job.provider === "baostock-autofill") ?? null;
}

function findLatestRunningAutoFillChildJob(jobs: StrategyIngestionJob[]) {
  return jobs.find((job) => job.status === "running" && !isStaleRunningIngestionJob(job) && stringFromUnknown(job.metadata.parent_job_id)) ?? null;
}

function ingestionControlJobId(job?: StrategyIngestionJob | null) {
  if (!job) return null;
  return job.provider === "baostock-autofill"
    ? job.id
    : stringFromUnknown(job.metadata.parent_job_id) ?? job.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type IngestionSymbolLog = {
  symbol: string;
  name?: string | null;
  status?: string | null;
  barsReceived?: number | null;
  rowsUpserted?: number | null;
  firstDate?: string | null;
  lastDate?: string | null;
  error?: string | null;
  skipReason?: string | null;
  coverageRowCount?: number | null;
  coverageFirstDate?: string | null;
  coverageLastDate?: string | null;
  missingFields?: string[];
};

function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function isStaleRunningIngestionJob(job: StrategyIngestionJob | null | undefined) {
  if (!job || job.status !== "running") return false;
  const control = stringFromUnknown(job.metadata.control);
  const controlUpdatedAt = timestampMs(stringFromUnknown(job.metadata.control_updated_at));
  if (control === "stop" && controlUpdatedAt && Date.now() - controlUpdatedAt > INGESTION_STOP_GRACE_MS) {
    return true;
  }
  const lastHeartbeatAt = timestampMs(stringFromUnknown(job.metadata.last_heartbeat_at));
  const lastActivityAt = lastHeartbeatAt ?? timestampMs(job.updatedAt);
  return Boolean(lastActivityAt && Date.now() - lastActivityAt > INGESTION_STALE_HEARTBEAT_MS);
}

function completedJobDurationSeconds(job: StrategyIngestionJob) {
  const startedAt = timestampMs(job.startedAt ?? job.createdAt);
  const endedAt = timestampMs(job.completedAt ?? job.updatedAt);
  if (!startedAt || !endedAt || endedAt <= startedAt) return null;
  return Math.max(1, (endedAt - startedAt) / 1000);
}

function recentIngestionSymbolRate(job: StrategyIngestionJob, jobs: StrategyIngestionJob[]) {
  const parentJobId = job.provider === "baostock-autofill"
    ? job.id
    : stringFromUnknown(job.metadata.parent_job_id);
  const relevantJobs = jobs
    .filter((item) => {
      if (item.id === job.id || item.status === "running" || item.completedSymbols <= 0) return false;
      if (parentJobId && stringFromUnknown(item.metadata.parent_job_id) === parentJobId) return true;
      if (!parentJobId && item.provider === job.provider && item.timeframe === job.timeframe) return true;
      return false;
    })
    .sort((a, b) => (timestampMs(b.completedAt ?? b.updatedAt) ?? 0) - (timestampMs(a.completedAt ?? a.updatedAt) ?? 0))
    .slice(0, 5);
  const totals = relevantJobs.reduce(
    (acc, item) => {
      const duration = completedJobDurationSeconds(item);
      if (!duration) return acc;
      return {
        symbols: acc.symbols + item.completedSymbols,
        seconds: acc.seconds + duration,
      };
    },
    { symbols: 0, seconds: 0 }
  );
  return totals.symbols > 0 && totals.seconds > 0 ? totals.symbols / totals.seconds : null;
}

function ingestionProgress(job: StrategyIngestionJob | null | undefined, jobs: StrategyIngestionJob[] = []) {
  if (!job) {
    return {
      completedBatches: 0,
      totalBatches: 0,
      completedSymbols: 0,
      totalSymbols: 0,
      percent: 0,
      elapsedSeconds: null as number | null,
      etaSeconds: null as number | null,
      currentSymbol: null as string | null,
      lastHeartbeatAt: null as string | null,
      control: null as string | null,
      preflightSkippedSymbols: 0,
      isStale: false,
    };
  }
  const completedBatches = numberFromUnknown(job.metadata.completed_batches) ?? 0;
  const totalBatches =
    numberFromUnknown(job.metadata.total_batches) ??
    numberFromUnknown(job.metadata.max_batches) ??
    Math.max(1, Math.ceil((job.universeTotalSymbols ?? job.totalSymbols) / Math.max(job.batchSize ?? 25, 1)));
  const completedSymbols = job.completedSymbols;
  const totalSymbols = job.universeTotalSymbols ?? job.totalSymbols;
  const percent = totalSymbols > 0 ? Math.min(100, Math.max(0, (completedSymbols / totalSymbols) * 100)) : 0;
  const startedAt = timestampMs(job.startedAt ?? job.createdAt);
  const endedAt = job.status === "running" ? Date.now() : timestampMs(job.completedAt ?? job.updatedAt);
  const elapsedSeconds = startedAt && endedAt ? Math.max(0, (endedAt - startedAt) / 1000) : null;
  const isStale = isStaleRunningIngestionJob(job);
  const recentRate = recentIngestionSymbolRate(job, jobs);
  const fallbackEtaSeconds =
    elapsedSeconds !== null && completedSymbols > 0 && totalSymbols > completedSymbols
      ? (elapsedSeconds / completedSymbols) * (totalSymbols - completedSymbols)
      : null;
  const etaSeconds = isStale || stringFromUnknown(job.metadata.control) === "stop"
    ? null
    : recentRate && totalSymbols > completedSymbols
      ? (totalSymbols - completedSymbols) / recentRate
      : fallbackEtaSeconds;
  return {
    completedBatches,
    totalBatches,
    completedSymbols,
    totalSymbols,
    percent,
    elapsedSeconds,
    etaSeconds,
    currentSymbol: stringFromUnknown(job.metadata.current_symbol),
    lastHeartbeatAt: stringFromUnknown(job.metadata.last_heartbeat_at) ?? job.updatedAt,
    control: stringFromUnknown(job.metadata.control),
    preflightSkippedSymbols: numberFromUnknown(job.metadata.preflight_skipped_symbols) ?? 0,
    isStale,
  };
}

function getIngestionSymbolLogs(job: StrategyIngestionJob): IngestionSymbolLog[] {
  const rawResults = job.metadata.symbol_results;
  const rawSymbols = Array.isArray(rawResults) && rawResults.length ? rawResults : job.metadata.symbols;
  if (!Array.isArray(rawSymbols)) return [];

  return rawSymbols
    .map((item): IngestionSymbolLog | null => {
      if (typeof item === "string") return { symbol: item };
      if (!isRecord(item)) return null;
      const symbol = stringFromUnknown(item.symbol) ?? stringFromUnknown(item.query);
      if (!symbol) return null;
      return {
        symbol,
        name: stringFromUnknown(item.name),
        status: stringFromUnknown(item.status),
        barsReceived: numberFromUnknown(item.bars_received),
        rowsUpserted: numberFromUnknown(item.rows_upserted),
        firstDate: stringFromUnknown(item.first_date),
        lastDate: stringFromUnknown(item.last_date),
        error: stringFromUnknown(item.error),
        skipReason: stringFromUnknown(item.skip_reason),
        coverageRowCount: numberFromUnknown(item.coverage_row_count),
        coverageFirstDate: stringFromUnknown(item.coverage_first_date),
        coverageLastDate: stringFromUnknown(item.coverage_last_date),
        missingFields: Array.isArray(item.missing_fields)
          ? item.missing_fields.map((value) => String(value)).filter(Boolean)
          : [],
      };
    })
    .filter((item): item is IngestionSymbolLog => Boolean(item));
}

function ingestionBatchRangeLabel(job: StrategyIngestionJob) {
  if (job.provider === "baostock-autofill") {
    const progress = ingestionProgress(job);
    return `${progress.completedBatches}/${progress.totalBatches} 批`;
  }
  const offset = job.batchOffset;
  if (offset === null || offset === undefined) return "单次任务";
  const size = job.batchSize ?? job.totalSymbols;
  const total = job.universeTotalSymbols;
  const start = offset + 1;
  const end = offset + Math.max(size, job.totalSymbols, 0);
  if (total !== null && total !== undefined) return `${start}-${Math.min(end, total)} / ${total}`;
  return `${start}-${end}`;
}

function ingestionSymbolPreview(job: StrategyIngestionJob) {
  const symbols = getIngestionSymbolLogs(job);
  if (!symbols.length) return "-";
  const skipped = symbols.filter((item) => item.skipReason === "local_coverage_ready").length;
  const preview = symbols.slice(0, 6).map((item) =>
    item.name ? `${item.symbol} ${item.name}` : item.symbol
  );
  const suffix = symbols.length > preview.length ? ` 等 ${symbols.length} 个` : "";
  const skipText = skipped ? `；本地跳过 ${skipped} 个` : "";
  return `${preview.join("、")}${suffix}${skipText}`;
}

function ingestionErrorPreview(job: StrategyIngestionJob) {
  if (job.error) return job.error;
  const failed = getIngestionSymbolLogs(job).filter((item) => item.error);
  if (!failed.length) return null;
  return failed
    .slice(0, 3)
    .map((item) => `${item.symbol}: ${item.error}`)
    .join("；");
}

// ─── Sub-nav items ─────────────────────────────────────────────
const SUB_NAV_ITEMS: SubNavItem[] = [
  { id: "universe", label: "股票池", icon: <SquareStack className="h-4 w-4" /> },
  { id: "catalog", label: "策略目录", icon: <TrendingUp className="h-4 w-4" /> },
  { id: "factors", label: "因子目录", icon: <GitBranch className="h-4 w-4" /> },
  { id: "sectorFlow", label: "板块资金", icon: <BarChart3 className="h-4 w-4" /> },
  { id: "foundation", label: "基础组件", icon: <DatabaseZap className="h-4 w-4" /> },
  { id: "knowledge", label: "金融知识", icon: <BookOpen className="h-4 w-4" /> },
];

// ─── Strategy Selector Bar ─────────────────────────────────────
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

const UNIVERSE_PAGE_SIZE = 10;
const DETAIL_ANIMATION_MS = 260;
const KLINE_TIMEFRAMES = [
  { id: "realtime", label: "实时" },
  { id: "daily", label: "日线" },
  { id: "weekly", label: "周线" },
  { id: "monthly", label: "月线" },
] as const;
type KlineTimeframe = (typeof KLINE_TIMEFRAMES)[number]["id"];
const MOVING_AVERAGE_CONFIGS = [
  { period: 5, label: "MA5", color: "#2563eb", textClass: "text-blue-600" },
  { period: 10, label: "MA10", color: "#16a34a", textClass: "text-emerald-600" },
  { period: 20, label: "MA20", color: "#d97706", textClass: "text-amber-600" },
  { period: 30, label: "MA30", color: "#db2777", textClass: "text-pink-600" },
  { period: 60, label: "MA60", color: "#7c3aed", textClass: "text-violet-600" },
] as const;

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

function UniverseView({
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
                placeholder="筛选名称、代码、板块、交易所..."
                className="h-9 border-slate-200 bg-white pl-9"
              />
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span>第 {currentPage} / {totalPages} 页</span>
              <Button variant="outline" size="sm" onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1 || isLoadingMembers}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage >= totalPages || isLoadingMembers}>
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
                  <th className="w-[9%] px-5 py-3 font-medium">标的名称</th>
                  <th className="w-[8%] px-3 py-3 font-medium">代码</th>
                  <th className="w-[38%] px-3 py-3 font-medium">所属板块</th>
                  <th className="w-[9%] px-3 py-3 font-medium">行情</th>
                  <th className="w-[10%] px-3 py-3 font-medium">强弱</th>
                  <th className="w-[9%] px-3 py-3 font-medium">趋势</th>
                  <th className="w-[10%] px-3 py-3 font-medium">流动性</th>
                  <th className="w-[7%] px-3 py-3 font-medium">估值</th>
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

function klineTimeframeLabel(value: string) {
  return KLINE_TIMEFRAMES.find((option) => option.id === value)?.label ?? value;
}

function klineFetchLimit(timeframe: KlineTimeframe) {
  if (timeframe === "realtime") return 0;
  if (timeframe === "daily") return 1260;
  if (timeframe === "weekly") return 260;
  return 120;
}

const KLINE_DETAIL_CACHE_TTL_MS = 60 * 1000;
const KLINE_DETAIL_CACHE_MAX = 96;
const REALTIME_QUOTE_REFRESH_MS = 15 * 1000;
const klineDetailCache = new Map<string, { data: StrategyLocalKlineResponse; expiresAt: number }>();
const klineDetailPromises = new Map<string, Promise<StrategyLocalKlineResponse>>();
const dividendEventsCache = new Map<string, { data: StrategyDividendEvent[]; expiresAt: number }>();
const dividendEventsPromises = new Map<string, Promise<StrategyDividendEvent[]>>();

function setBoundedCacheValue<T>(cache: Map<string, { data: T; expiresAt: number }>, key: string, data: T) {
  cache.set(key, { data, expiresAt: Date.now() + KLINE_DETAIL_CACHE_TTL_MS });
  while (cache.size > KLINE_DETAIL_CACHE_MAX) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function getFreshCacheValue<T>(cache: Map<string, { data: T; expiresAt: number }>, key: string) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.data;
}

function klineDetailCacheKey(symbol: string, timeframe: KlineTimeframe, adjustment: string) {
  return `${symbol}::${timeframe}::${adjustment}`;
}

function dividendEventsCacheKey(symbol: string) {
  return `${symbol}::dividends`;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function movingAverageSeries(bars: StrategyLocalKlineBar[], period: number) {
  let sum = 0;
  return bars.map((bar, index) => {
    sum += bar.close;
    if (index >= period) {
      sum -= bars[index - period].close;
    }
    return index >= period - 1 ? sum / period : null;
  });
}

function movingAverageAtIndex(bars: StrategyLocalKlineBar[], period: number, index: number) {
  if (index < period - 1) return null;
  const window = bars.slice(index - period + 1, index + 1);
  if (window.length < period || window.some((bar) => finiteNumber(bar.close) === null)) return null;
  return window.reduce((sum, bar) => sum + bar.close, 0) / period;
}

function returnPctForBar(bars: StrategyLocalKlineBar[], index: number) {
  const directValue = finiteNumber(bars[index]?.changePercent);
  if (directValue !== null) return directValue;
  const current = finiteNumber(bars[index]?.close);
  const previous = finiteNumber(bars[index]?.previousClose) ?? finiteNumber(bars[index - 1]?.close);
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function normalizedTradeDate(value?: string | null) {
  const formatted = formatDataDate(value);
  return formatted === "-" ? null : formatted;
}

function dateKeyToTime(dateKey?: string | null) {
  if (!dateKey) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function dateKeyToWeekKey(dateKey: string) {
  const time = dateKeyToTime(dateKey);
  if (time === null) return dateKey;
  const date = new Date(time);
  const day = date.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  const monday = new Date(time - mondayOffset * 24 * 60 * 60 * 1000);
  return monday.toISOString().slice(0, 10);
}

function klineAggregationKey(bar: StrategyLocalKlineBar, timeframe: KlineTimeframe) {
  const dateKey = normalizedTradeDate(bar.ts);
  if (!dateKey) return bar.ts;
  if (timeframe === "monthly") return dateKey.slice(0, 7);
  if (timeframe === "weekly") return dateKeyToWeekKey(dateKey);
  return dateKey;
}

function aggregateKlineBars(bars: StrategyLocalKlineBar[], timeframe: KlineTimeframe) {
  if (timeframe === "daily" || timeframe === "realtime") return bars;
  const grouped = new Map<string, StrategyLocalKlineBar[]>();
  for (const bar of bars) {
    const key = klineAggregationKey(bar, timeframe);
    const group = grouped.get(key) ?? [];
    group.push(bar);
    grouped.set(key, group);
  }

  return Array.from(grouped.values()).map((group) => {
    const sorted = group.slice().sort((left, right) => {
      const leftTime = new Date(left.ts).getTime();
      const rightTime = new Date(right.ts).getTime();
      return leftTime - rightTime;
    });
    const first = sorted[0];
    const last = sorted.at(-1) ?? first;
    const high = Math.max(...sorted.map((bar) => bar.high));
    const low = Math.min(...sorted.map((bar) => bar.low));
    const volume = sorted.reduce((sum, bar) => sum + bar.volume, 0);
    const amountValues = sorted.map((bar) => finiteNumber(bar.amount)).filter((value): value is number => value !== null);
    const amount = amountValues.length ? amountValues.reduce((sum, value) => sum + value, 0) : null;
    const previousClose = finiteNumber(first.previousClose);
    const changeAmount = previousClose !== null ? last.close - previousClose : null;
    const changePercent = previousClose !== null && previousClose !== 0 ? (changeAmount! / previousClose) * 100 : null;
    const amplitude = previousClose !== null && previousClose !== 0 ? ((high - low) / previousClose) * 100 : null;
    return {
      ...last,
      ts: last.ts,
      open: first.open,
      high,
      low,
      close: last.close,
      previousClose,
      volume,
      amount,
      amplitude,
      changeAmount,
      changePercent,
      turnover: null,
      limitUp: null,
      limitDown: null,
      metadata: {},
    };
  });
}

function buildKlineSummary(bars: StrategyLocalKlineBar[], rowCount = bars.length): StrategyLocalKlineResponse["summary"] {
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const previousClose = finiteNumber(previous?.close) ?? finiteNumber(latest?.previousClose);
  const totalAmountValues = bars.map((bar) => finiteNumber(bar.amount)).filter((value): value is number => value !== null);
  return {
    rowCount,
    firstTs: bars[0]?.ts ?? null,
    lastTs: latest?.ts ?? null,
    latestClose: latest?.close ?? null,
    previousClose,
    returnPct:
      latest && previousClose !== null && previousClose !== 0
        ? ((latest.close - previousClose) / previousClose) * 100
        : null,
    high: bars.length ? Math.max(...bars.map((bar) => bar.high)) : null,
    low: bars.length ? Math.min(...bars.map((bar) => bar.low)) : null,
    totalVolume: bars.reduce((sum, bar) => sum + bar.volume, 0),
    totalAmount: totalAmountValues.length ? totalAmountValues.reduce((sum, value) => sum + value, 0) : null,
  };
}

function deriveKlineResponse(
  dailyDetail: StrategyLocalKlineResponse,
  timeframe: KlineTimeframe,
  limit: number
): StrategyLocalKlineResponse {
  if (timeframe === "realtime") return dailyDetail;
  if (timeframe === "daily") {
    const bars = dailyDetail.bars.slice(-limit).map((bar) => ({ ...bar, metadata: {} }));
    const windowSummary = buildKlineSummary(bars);
    return {
      ...dailyDetail,
      timeframe,
      bars,
      summary: {
        ...dailyDetail.summary,
        high: windowSummary.high,
        low: windowSummary.low,
        totalVolume: windowSummary.totalVolume,
        totalAmount: windowSummary.totalAmount,
      },
    };
  }
  const allBars = aggregateKlineBars(dailyDetail.bars, timeframe);
  const bars = allBars.slice(-limit);
  return {
    ...dailyDetail,
    timeframe,
    bars,
    summary: buildKlineSummary(bars, allBars.length),
  };
}

function readCachedKlineDetail(symbol: string, timeframe: KlineTimeframe, adjustment: string) {
  return getFreshCacheValue(klineDetailCache, klineDetailCacheKey(symbol, timeframe, adjustment));
}

async function fetchDailyKlineDetail(symbol: string, adjustment: string): Promise<StrategyLocalKlineResponse> {
  const response = await fetch(`${API_BASE}/api/quant/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "symbol-bars",
      symbol,
      timeframe: "daily",
      adjustment,
      limit: klineFetchLimit("daily"),
      includeMetadata: false,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error ?? "读取 K 线失败");
  return deriveKlineResponse(payload.data as StrategyLocalKlineResponse, "daily", klineFetchLimit("daily"));
}

async function loadCachedKlineDetail(
  symbol: string,
  timeframe: KlineTimeframe,
  adjustment: string
): Promise<StrategyLocalKlineResponse> {
  const key = klineDetailCacheKey(symbol, timeframe, adjustment);
  const cached = getFreshCacheValue(klineDetailCache, key);
  if (cached) return cached;
  const inFlight = klineDetailPromises.get(key);
  if (inFlight) return inFlight;

  const promise: Promise<StrategyLocalKlineResponse> = (async (): Promise<StrategyLocalKlineResponse> => {
    const data: StrategyLocalKlineResponse = timeframe === "daily"
      ? await fetchDailyKlineDetail(symbol, adjustment)
      : deriveKlineResponse(
          await loadCachedKlineDetail(symbol, "daily", adjustment),
          timeframe,
          klineFetchLimit(timeframe)
        );
    setBoundedCacheValue(klineDetailCache, key, data);
    return data;
  })();

  klineDetailPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    klineDetailPromises.delete(key);
  }
}

async function loadCachedDividendEvents(symbol: string) {
  const key = dividendEventsCacheKey(symbol);
  const cached = getFreshCacheValue(dividendEventsCache, key);
  if (cached) return cached;
  const inFlight = dividendEventsPromises.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const response = await fetch(`${API_BASE}/api/quant/strategies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "symbol-dividends",
        symbol,
        limit: 40,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error ?? "读取分红事件失败");
    const events = (payload.data?.events ?? []) as StrategyDividendEvent[];
    setBoundedCacheValue(dividendEventsCache, key, events);
    return events;
  })();

  dividendEventsPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    dividendEventsPromises.delete(key);
  }
}

function strategyApiErrorMessage(payload: unknown, fallback: string) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const message = typeof record.message === "string" ? record.message.trim() : "";
  const error = typeof record.error === "string" ? record.error.trim() : "";
  return message || error || fallback;
}

async function fetchRealtimeQuote(symbol: string): Promise<StrategyRealtimeQuote> {
  const response = await fetch(`${API_BASE}/api/quant/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "realtime-quote",
      symbol,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(strategyApiErrorMessage(payload, "读取实时行情失败"));
  return payload.data as StrategyRealtimeQuote;
}

async function fetchIntradayBars(symbol: string, options?: { forceRefresh?: boolean }): Promise<StrategyLocalKlineResponse> {
  const response = await fetch(`${API_BASE}/api/quant/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "intraday-bars",
      symbol,
      period: "minute1",
      limit: 260,
      refresh: options?.forceRefresh === true,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(strategyApiErrorMessage(payload, "读取分时行情失败"));
  return payload.data as StrategyLocalKlineResponse;
}

function resolveDividendMarkerIndex(
  visibleBars: StrategyLocalKlineBar[],
  eventDateKey: string,
  timeframe: KlineTimeframe
) {
  const barDateKeys = visibleBars.map((bar) => normalizedTradeDate(bar.ts));
  const exactIndex = barDateKeys.findIndex((dateKey) => dateKey === eventDateKey);
  if (exactIndex >= 0) return exactIndex;

  const eventTime = dateKeyToTime(eventDateKey);
  if (eventTime === null) return -1;

  const barTimes = barDateKeys.map(dateKeyToTime);
  const oneDay = 24 * 60 * 60 * 1000;

  if (timeframe === "daily") {
    return barTimes.findIndex((barTime) =>
      barTime !== null && barTime >= eventTime && barTime - eventTime <= oneDay * 4
    );
  }

  const maxWindow = timeframe === "weekly" ? oneDay * 10 : oneDay * 35;
  for (let index = 0; index < barTimes.length; index += 1) {
    const current = barTimes[index];
    if (current === null || current < eventTime) continue;
    const previous = index > 0 ? barTimes[index - 1] : null;
    const isInBucket = previous === null
      ? current - eventTime <= maxWindow
      : eventTime > previous && eventTime <= current;
    if (isInBucket) return index;
  }

  return -1;
}

function limitThresholdForSymbol(symbol: string, name?: string | null, exchange?: string | null) {
  const code = symbol.split(".", 1)[0];
  if ((name ?? "").toUpperCase().includes("ST")) return 5;
  if (exchange === "BJ" || code.startsWith("4") || code.startsWith("8")) return 30;
  if (code.startsWith("300") || code.startsWith("301") || code.startsWith("688")) return 20;
  return 10;
}

function limitMarkerForBar(
  bar: StrategyLocalKlineBar,
  threshold: number,
  timeframe: KlineTimeframe
): "up" | "down" | null {
  if (timeframe !== "daily") return null;
  if (bar.limitUp) return "up";
  if (bar.limitDown) return "down";
  const changePercent = finiteNumber(bar.changePercent);
  if (changePercent === null) return null;
  const tolerance = threshold >= 20 ? 0.12 : 0.06;
  if (changePercent >= threshold - tolerance) return "up";
  if (changePercent <= -threshold + tolerance) return "down";
  return null;
}

function KlineMiniChart({
  bars,
  dividendEvents,
  symbol,
  name,
  exchange,
  timeframe,
  selectedBarTs,
  onSelectBar,
  onResetSelection,
}: {
  bars: StrategyLocalKlineBar[];
  dividendEvents: StrategyDividendEvent[];
  symbol: string;
  name?: string | null;
  exchange?: string | null;
  timeframe: KlineTimeframe;
  selectedBarTs?: string | null;
  onSelectBar?: (bar: StrategyLocalKlineBar) => void;
  onResetSelection?: () => void;
}) {
  const cleanBars = useMemo(
    () => bars.filter((bar) =>
      [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        (value) => typeof value === "number" && Number.isFinite(value)
      )
    ),
    [bars]
  );
  const visibleCount = Math.min(90, cleanBars.length);
  const maxStartIndex = Math.max(0, cleanBars.length - visibleCount);
  const [startIndex, setStartIndex] = useState(maxStartIndex);
  const dragRef = useRef<{ x: number; startIndex: number; hasMoved: boolean } | null>(null);
  const resolvedStartIndex = clampNumber(startIndex, 0, maxStartIndex);
  const visibleBars = cleanBars.slice(resolvedStartIndex, resolvedStartIndex + visibleCount);
  const selectedVisibleIndex = visibleBars.findIndex((bar) => bar.ts === selectedBarTs);
  const averages = useMemo(
    () => MOVING_AVERAGE_CONFIGS.map((config) => ({
      ...config,
      values: movingAverageSeries(cleanBars, config.period),
    })),
    [cleanBars]
  );
  const visibleAverages = averages.map((average) => ({
    ...average,
    values: average.values.slice(resolvedStartIndex, resolvedStartIndex + visibleCount),
  }));
  const activeVisibleAverages = visibleAverages.filter((average) =>
    average.values.some((value) => finiteNumber(value) !== null)
  );
  const dividendMarkersByIndex = useMemo(() => {
    const map = new Map<number, StrategyDividendEvent[]>();
    for (const event of dividendEvents) {
      const date = normalizedTradeDate(event.exDividendDate);
      if (!date) continue;
      const index = resolveDividendMarkerIndex(visibleBars, date, timeframe);
      if (index < 0) continue;
      const events = map.get(index) ?? [];
      events.push(event);
      map.set(index, events);
    }
    return map;
  }, [dividendEvents, timeframe, visibleBars]);

  useEffect(() => {
    setStartIndex(maxStartIndex);
  }, [maxStartIndex, bars]);

  if (!visibleBars.length) {
    return (
      <div className="flex h-[340px] items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
        暂无可展示的 K 线样本
      </div>
    );
  }

  const width = 1320;
  const height = 360;
  const left = 66;
  const right = 24;
  const chartTop = 24;
  const chartHeight = 220;
  const volumeTop = 278;
  const volumeHeight = 42;
  const dateLabelY = height - 10;
  const chartWidth = width - left - right;
  const priceValues = [
    ...visibleBars.flatMap((bar) => [bar.high, bar.low]),
    ...visibleAverages.flatMap((average) => average.values).filter((value): value is number => value !== null),
  ];
  const highest = Math.max(...priceValues);
  const lowest = Math.min(...priceValues);
  const priceRange = Math.max(highest - lowest, 0.01);
  const maxVolume = Math.max(...visibleBars.map((bar) => bar.volume), 1);
  const step = chartWidth / visibleBars.length;
  const candleWidth = Math.max(3, Math.min(10, step * 0.55));
  const priceY = (price: number) => chartTop + ((highest - price) / priceRange) * chartHeight;
  const limitThreshold = limitThresholdForSymbol(symbol, name, exchange);
  const buildAveragePath = (values: Array<number | null>) =>
    values.reduce((path, value, index) => {
      if (value === null) return path;
      const x = left + index * step + step / 2;
      const y = priceY(value);
      return `${path}${path ? " L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }, "");
  const rangeLeftPct = cleanBars.length ? (resolvedStartIndex / cleanBars.length) * 100 : 0;
  const rangeWidthPct = cleanBars.length ? (visibleBars.length / cleanBars.length) * 100 : 100;
  const visibleIndexFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !visibleBars.length) return -1;
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    const localY = ((event.clientY - rect.top) / rect.height) * height;
    if (localX < left || localX > width - right || localY < chartTop || localY > volumeTop + volumeHeight) {
      return -1;
    }
    const rawIndex = Math.round((localX - left - step / 2) / step);
    return clampNumber(rawIndex, 0, visibleBars.length - 1);
  };
  const selectBarFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const index = visibleIndexFromPointer(event);
    const bar = index >= 0 ? visibleBars[index] : null;
    if (bar) {
      onSelectBar?.(bar);
    } else {
      onResetSelection?.();
    }
  };
  const moveByDelta = (clientX: number) => {
    if (!dragRef.current || !maxStartIndex) return;
    const pixelsPerBar = Math.max(8, step);
    const deltaBars = Math.round((clientX - dragRef.current.x) / pixelsPerBar);
    setStartIndex(clampNumber(dragRef.current.startIndex - deltaBars, 0, maxStartIndex));
  };
  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    selectBarFromPointer(event);
    if (!maxStartIndex) return;
    dragRef.current = { x: event.clientX, startIndex: resolvedStartIndex, hasMoved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (dragRef.current && event.buttons === 1) {
      dragRef.current.hasMoved = dragRef.current.hasMoved || Math.abs(event.clientX - dragRef.current.x) > 3;
      moveByDelta(event.clientX);
      return;
    }
    selectBarFromPointer(event);
  };
  const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (dragRef.current && !dragRef.current.hasMoved) {
      selectBarFromPointer(event);
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const handlePointerLeave = () => {
    if (!dragRef.current) onResetSelection?.();
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
        <span>{formatDataDate(visibleBars[0]?.ts)} 至 {formatDataDate(visibleBars.at(-1)?.ts)}</span>
        <div className="flex flex-wrap items-center gap-3">
          {activeVisibleAverages.map((average) => (
            <span key={average.label} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: average.color }} />
              {average.label}
            </span>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={cn("h-[360px] w-full touch-pan-y select-none", maxStartIndex ? "cursor-grab active:cursor-grabbing" : "cursor-default")}
        role="img"
        aria-label="本地 K 线图"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = chartTop + ratio * chartHeight;
          const price = highest - ratio * priceRange;
          return (
            <g key={ratio}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="3 4" />
              <text x={12} y={y + 5} className="fill-slate-400 text-[14px]">
                {price.toFixed(2)}
              </text>
            </g>
          );
        })}
        <line x1={left} x2={width - right} y1={volumeTop - 10} y2={volumeTop - 10} stroke="#e2e8f0" />
        {visibleBars.map((bar, index) => {
          const x = left + index * step + step / 2;
          const isUp = bar.close >= bar.open;
          const color = isUp ? "#dc2626" : "#059669";
          const yHigh = priceY(bar.high);
          const yLow = priceY(bar.low);
          const yOpen = priceY(bar.open);
          const yClose = priceY(bar.close);
          const bodyTop = Math.min(yOpen, yClose);
          const bodyHeight = Math.max(Math.abs(yClose - yOpen), 1);
          const volumeHeightPx = (bar.volume / maxVolume) * volumeHeight;
          return (
            <g key={`${bar.ts}-${index}`}>
              <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1.2} />
              <rect
                x={x - candleWidth / 2}
                y={bodyTop}
                width={candleWidth}
                height={bodyHeight}
                fill={isUp ? "#fff1f2" : color}
                stroke={color}
                strokeWidth={1}
              />
              <rect
                x={x - candleWidth / 2}
                y={volumeTop + volumeHeight - volumeHeightPx}
                width={candleWidth}
                height={volumeHeightPx}
                fill={isUp ? "#fecdd3" : "#a7f3d0"}
              />
            </g>
          );
        })}
        {activeVisibleAverages.map((average) => {
          const path = buildAveragePath(average.values);
          return path ? (
            <path
              key={average.label}
              d={path}
              fill="none"
              stroke={average.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.4}
            />
          ) : null;
        })}
        {selectedVisibleIndex >= 0 && (
          <g pointerEvents="none">
            {(() => {
              const selectedBar = visibleBars[selectedVisibleIndex];
              const selectedX = left + selectedVisibleIndex * step + step / 2;
              return (
                <>
                  <rect
                    x={selectedX - step / 2}
                    y={chartTop}
                    width={step}
                    height={volumeTop + volumeHeight - chartTop}
                    fill="#dbeafe"
                    opacity={0.3}
                  />
                  <line
                    x1={selectedX}
                    x2={selectedX}
                    y1={chartTop}
                    y2={volumeTop + volumeHeight}
                    stroke="#2563eb"
                    strokeDasharray="4 4"
                    strokeWidth={1.2}
                  />
                  <circle
                    cx={selectedX}
                    cy={priceY(selectedBar.close)}
                    r={4.5}
                    fill="#2563eb"
                    stroke="#ffffff"
                    strokeWidth={2}
                  />
                </>
              );
            })()}
          </g>
        )}
        {visibleBars.map((bar, index) => {
          const x = left + index * step + step / 2;
          const dividendEventsForBar = dividendMarkersByIndex.get(index) ?? [];
          const limitMarker = limitMarkerForBar(bar, limitThreshold, timeframe);
          const yHigh = priceY(bar.high);
          const yLow = priceY(bar.low);
          const dividendBadgeY = Math.max(chartTop + 2, yHigh - 36);
          return (
            <g key={`${bar.ts}-${index}-markers`}>
              {dividendEventsForBar.length > 0 && (
                <g>
                  <title>
                    {dividendEventsForBar.map((event) =>
                      `除权除息日 ${formatDataDate(event.exDividendDate)}：${event.planProfile ?? "分红送配"}`
                    ).join("；")}
                  </title>
                  <line
                    x1={x}
                    x2={x}
                    y1={chartTop}
                    y2={volumeTop + volumeHeight}
                    stroke="#f59e0b"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    opacity={0.85}
                  />
                  <circle
                    cx={x}
                    cy={Math.max(chartTop + 24, yHigh)}
                    r={4.8}
                    fill="#f59e0b"
                    stroke="#fff7ed"
                    strokeWidth={2}
                  />
                  <g transform={`translate(${x - 13}, ${dividendBadgeY})`}>
                    <rect
                      width={26}
                      height={18}
                      rx={4}
                      fill="#fffbeb"
                      stroke="#f59e0b"
                      strokeWidth={1}
                    />
                    <text
                      x={13}
                      y={13}
                      textAnchor="middle"
                      className="fill-amber-700 text-[11px] font-bold"
                    >
                      除
                    </text>
                  </g>
                </g>
              )}
              {limitMarker && (
                <g transform={`translate(${x - 11}, ${limitMarker === "up" ? Math.max(chartTop + 2, yHigh - 22) : Math.min(chartTop + chartHeight - 14, yLow + 8)})`}>
                  <rect
                    width={22}
                    height={16}
                    rx={3}
                    fill={limitMarker === "up" ? "#fee2e2" : "#dcfce7"}
                    stroke={limitMarker === "up" ? "#ef4444" : "#22c55e"}
                    strokeWidth={0.8}
                  />
                  <text
                    x={11}
                    y={11.5}
                    textAnchor="middle"
                    className={cn(
                      "text-[10px] font-semibold",
                      limitMarker === "up" ? "fill-red-600" : "fill-emerald-600"
                    )}
                  >
                    <title>
                      {limitMarker === "up" ? "涨停" : "跌停"}：{formatSignedPercent(bar.changePercent)}
                    </title>
                    {limitMarker === "up" ? "涨" : "跌"}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        <text x={left} y={dateLabelY} className="fill-slate-500 text-[14px]">
          {formatDataDate(visibleBars[0]?.ts)}
        </text>
        <text x={width - right} y={dateLabelY} textAnchor="end" className="fill-slate-500 text-[14px]">
          {formatDataDate(visibleBars.at(-1)?.ts)}
        </text>
      </svg>
      <div className="mt-2 h-1.5 rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-blue-500"
          style={{
            marginLeft: `${rangeLeftPct}%`,
            width: `${Math.max(4, rangeWidthPct)}%`,
          }}
        />
      </div>
    </div>
  );
}

function IntradayTimeShareChart({
  detail,
  previousClose,
}: {
  detail: StrategyLocalKlineResponse;
  previousClose?: number | null;
}) {
  const cleanBars = useMemo(
    () => detail.bars.filter((bar) =>
      [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        (value) => typeof value === "number" && Number.isFinite(value)
      )
    ),
    [detail.bars]
  );
  const points = useMemo(() => {
    let cumulativeAmount = 0;
    let cumulativeVolume = 0;
    return cleanBars.map((bar) => {
      const amount = finiteNumber(bar.amount);
      if (amount !== null) cumulativeAmount += amount;
      cumulativeVolume += bar.volume;
      const averagePrice = cumulativeAmount > 0 && cumulativeVolume > 0
        ? cumulativeAmount / (cumulativeVolume * 100)
        : bar.close;
      return { bar, averagePrice };
    });
  }, [cleanBars]);
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, points.length - 1));
  const [crosshairX, setCrosshairX] = useState<number | null>(null);
  const resolvedSelectedIndex = clampNumber(selectedIndex, 0, Math.max(0, points.length - 1));
  const selectedPoint = points[resolvedSelectedIndex] ?? points.at(-1) ?? null;
  const baseline = finiteNumber(previousClose) ?? finiteNumber(detail.summary.previousClose) ?? points[0]?.bar.open ?? null;

  useEffect(() => {
    setSelectedIndex(Math.max(0, points.length - 1));
    setCrosshairX(null);
  }, [points.length]);

  if (!points.length) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
        暂无可展示的分时数据
      </div>
    );
  }

  const width = 1320;
  const height = 360;
  const left = 66;
  const right = 28;
  const chartTop = 24;
  const chartHeight = 215;
  const volumeTop = 278;
  const volumeHeight = 46;
  const dateLabelY = height - 11;
  const chartWidth = width - left - right;
  const priceValues = [
    ...points.flatMap((point) => [point.bar.high, point.bar.low, point.bar.close, point.averagePrice]),
    ...(baseline !== null ? [baseline] : []),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const highest = Math.max(...priceValues);
  const lowest = Math.min(...priceValues);
  const padding = Math.max((highest - lowest) * 0.08, highest * 0.002, 0.02);
  const priceHigh = highest + padding;
  const priceLow = lowest - padding;
  const priceRange = Math.max(priceHigh - priceLow, 0.01);
  const maxVolume = Math.max(...points.map((point) => point.bar.volume), 1);
  const step = points.length > 1 ? chartWidth / (points.length - 1) : chartWidth;
  const barWidth = Math.max(2, Math.min(7, chartWidth / points.length * 0.55));
  const priceY = (price: number) => chartTop + ((priceHigh - price) / priceRange) * chartHeight;
  const pointX = (index: number) => left + index * step;
  const buildPath = (values: number[]) =>
    values.reduce((path, value, index) => {
      const x = pointX(index);
      const y = priceY(value);
      return `${path}${path ? " L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }, "");
  const pricePath = buildPath(points.map((point) => point.bar.close));
  const averagePath = buildPath(points.map((point) => point.averagePrice));
  const selectedPointX = pointX(resolvedSelectedIndex);
  const selectedX = crosshairX ?? selectedPointX;
  const selectedBar = selectedPoint?.bar ?? null;
  const selectedAverage = selectedPoint?.averagePrice ?? null;
  const selectedChangePct = selectedBar && baseline
    ? ((selectedBar.close - baseline) / baseline) * 100
    : selectedBar?.changePercent ?? null;
  const selectedMetrics = selectedBar
    ? [
        { label: "时间", value: formatIntradayTime(selectedBar.ts) },
        { label: "价格", value: formatNumberValue(selectedBar.close), className: signedToneClass(selectedChangePct) },
        { label: "均价", value: formatNumberValue(selectedAverage), className: "text-amber-600" },
        { label: "涨跌", value: formatSignedPercent(selectedChangePct), className: signedToneClass(selectedChangePct) },
        { label: "成交量", value: formatLargeValue(selectedBar.volume, 0) },
        { label: "成交额", value: formatLargeValue(selectedBar.amount, 1) },
        { label: "换手", value: formatPercentValue(selectedBar.turnover) },
      ]
    : [];
  const selectFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const screenMatrix = svg.getScreenCTM();
    if (!screenMatrix) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const localPoint = point.matrixTransform(screenMatrix.inverse());
    const localX = localPoint.x;
    const nextX = clampNumber(localX, left, width - right);
    const rawIndex = Math.round((nextX - left) / step);
    setCrosshairX(nextX);
    setSelectedIndex(clampNumber(rawIndex, 0, points.length - 1));
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
          <span>{formatIntradayTime(points[0]?.bar.ts)} 至 {formatIntradayTime(points.at(-1)?.bar.ts)}</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-blue-600" />
            分时价
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            均价
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-slate-300" />
            昨收 {formatNumberValue(baseline)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedMetrics.map((item) => (
            <div key={item.label} className="inline-flex items-baseline gap-1 rounded bg-slate-50 px-2 py-1">
              <span className="text-xs text-slate-500">{item.label}</span>
              <span className={cn("text-sm font-semibold tabular-nums text-slate-950", item.className)}>
                {item.value}
              </span>
            </div>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[360px] w-full touch-pan-y select-none"
        role="img"
        aria-label="分时行情图"
        onPointerMove={selectFromPointer}
        onPointerDown={selectFromPointer}
        onPointerLeave={() => {
          setSelectedIndex(Math.max(0, points.length - 1));
          setCrosshairX(null);
        }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = chartTop + ratio * chartHeight;
          const price = priceHigh - ratio * priceRange;
          const change = baseline ? ((price - baseline) / baseline) * 100 : null;
          return (
            <g key={ratio}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="3 4" />
              <text x={12} y={y + 5} className="fill-slate-400 text-[13px]">
                {price.toFixed(2)}
              </text>
              <text x={width - right + 4} y={y + 5} className={cn("fill-current text-[12px]", signedToneClass(change))}>
                {formatSignedPercent(change)}
              </text>
            </g>
          );
        })}
        {baseline !== null && (
          <line
            x1={left}
            x2={width - right}
            y1={priceY(baseline)}
            y2={priceY(baseline)}
            stroke="#94a3b8"
            strokeDasharray="5 5"
            strokeWidth={1}
          />
        )}
        <line x1={left} x2={width - right} y1={volumeTop - 10} y2={volumeTop - 10} stroke="#e2e8f0" />
        {points.map((point, index) => {
          const x = pointX(index);
          const isUp = point.bar.close >= point.bar.open;
          const volumeHeightPx = (point.bar.volume / maxVolume) * volumeHeight;
          return (
            <rect
              key={`${point.bar.ts}-${index}-volume`}
              x={x - barWidth / 2}
              y={volumeTop + volumeHeight - volumeHeightPx}
              width={barWidth}
              height={Math.max(1, volumeHeightPx)}
              fill={isUp ? "#fecdd3" : "#a7f3d0"}
            />
          );
        })}
        <path
          d={pricePath}
          fill="none"
          stroke="#2563eb"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.8}
        />
        <path
          d={averagePath}
          fill="none"
          stroke="#f59e0b"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.6}
        />
        {selectedBar && (
          <g pointerEvents="none">
            <line
              x1={selectedX}
              x2={selectedX}
              y1={chartTop}
              y2={volumeTop + volumeHeight}
              stroke="#2563eb"
              strokeDasharray="4 4"
              strokeWidth={1.1}
            />
            <circle
              cx={selectedPointX}
              cy={priceY(selectedBar.close)}
              r={4.5}
              fill="#2563eb"
              stroke="#ffffff"
              strokeWidth={2}
            />
          </g>
        )}
        <text x={left} y={dateLabelY} className="fill-slate-500 text-[13px]">
          {formatIntradayTime(points[0]?.bar.ts)}
        </text>
        <text x={width / 2} y={dateLabelY} textAnchor="middle" className="fill-slate-400 text-[13px]">
          11:30 / 13:00
        </text>
        <text x={width - right} y={dateLabelY} textAnchor="end" className="fill-slate-500 text-[13px]">
          {formatIntradayTime(points.at(-1)?.bar.ts)}
        </text>
      </svg>
    </div>
  );
}

function RealtimeQuotePanel({
  quote,
  member,
  isRefreshing,
  onRefresh,
}: {
  quote: StrategyRealtimeQuote;
  member: StrategyUniverseMember;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const tone = signedToneClass(quote.changePercent);
  const quoteTime = quote.quoteTime ?? quote.asOf ?? quote.fetchedAt;
  const cards = [
    { label: "最新价", value: formatNumberValue(quote.price), className: tone },
    { label: "涨跌幅", value: formatSignedPercent(quote.changePercent), className: tone },
    { label: "涨跌额", value: formatSignedNumberValue(quote.changeAmount), className: tone },
    { label: "开盘", value: formatNumberValue(quote.open) },
    { label: "最高", value: formatNumberValue(quote.high), className: "text-red-600" },
    { label: "最低", value: formatNumberValue(quote.low), className: "text-emerald-600" },
    { label: "前收", value: formatNumberValue(quote.previousClose) },
    { label: "振幅", value: formatPercentValue(quote.amplitude) },
    { label: "换手", value: formatPercentValue(quote.turnover) },
    { label: "成交量", value: formatLargeValue(quote.volume, 1) },
    { label: "成交额", value: formatLargeValue(quote.amount, 1) },
    { label: "流通市值", value: formatLargeValue(quote.floatMarketCap, 1) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-base font-semibold text-slate-950">{quote.name ?? member.name ?? member.symbol}</p>
            <span className="font-mono text-sm text-slate-500">{member.symbol}</span>
            <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
              {quote.source}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            行情时间 {formatDateTime(quoteTime)} · {quote.market || member.exchange} · {quote.currency}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="gap-2"
        >
          <RefreshCcw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) => (
          <div key={card.label} className="rounded-md border border-slate-100 bg-white px-4 py-3 shadow-sm">
            <p className="text-sm text-slate-500">{card.label}</p>
            <p className={cn("mt-1 text-xl font-semibold tabular-nums text-slate-950", card.className)}>
              {card.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-slate-100 bg-white px-4 py-3">
          <p className="text-sm text-slate-500">总市值</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{formatLargeValue(quote.marketCap, 1)}</p>
        </div>
        <div className="rounded-md border border-slate-100 bg-white px-4 py-3">
          <p className="text-sm text-slate-500">数据质量</p>
          <p className="mt-1 text-lg font-semibold text-slate-950">{quote.dataQualityStatus ?? "-"}</p>
        </div>
        <div className="rounded-md border border-slate-100 bg-white px-4 py-3">
          <p className="text-sm text-slate-500">刷新状态</p>
          <p className="mt-1 text-lg font-semibold text-slate-950">
            {isRefreshing ? "刷新中" : `约 ${Math.round(REALTIME_QUOTE_REFRESH_MS / 1000)} 秒`}
          </p>
        </div>
      </div>
    </div>
  );
}

function StockKlineDetail({
  member,
  universe,
}: {
  member: StrategyUniverseMember;
  universe: StrategyUniverse;
}) {
  const initialTimeframe = KLINE_TIMEFRAMES.some((option) => option.id === universe.defaultTimeframe)
    ? (universe.defaultTimeframe as KlineTimeframe)
    : "daily";
  const adjustment = universe.defaultAdjustment || "qfq";
  const [detailTimeframe, setDetailTimeframe] = useState<KlineTimeframe>("daily");
  const [detail, setDetail] = useState<StrategyLocalKlineResponse | null>(null);
  const [realtimeQuote, setRealtimeQuote] = useState<StrategyRealtimeQuote | null>(null);
  const [intradayDetail, setIntradayDetail] = useState<StrategyLocalKlineResponse | null>(null);
  const [selectedBarTs, setSelectedBarTs] = useState<string | null>(null);
  const [dividendEvents, setDividendEvents] = useState<StrategyDividendEvent[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isLoadingRealtime, setIsLoadingRealtime] = useState(false);
  const [isLoadingIntraday, setIsLoadingIntraday] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [intradayError, setIntradayError] = useState<string | null>(null);
  const detailRequestIdRef = useRef(0);
  const realtimeRequestIdRef = useRef(0);
  const intradayRequestIdRef = useRef(0);

  const loadRealtimeQuote = useCallback(async (options?: { silent?: boolean }) => {
    const requestId = realtimeRequestIdRef.current + 1;
    realtimeRequestIdRef.current = requestId;
    setRealtimeError(null);
    if (!options?.silent) {
      setIsLoadingRealtime(true);
    }
    try {
      const quote = await fetchRealtimeQuote(member.symbol);
      if (realtimeRequestIdRef.current !== requestId) return;
      setRealtimeQuote(quote);
    } catch (error) {
      if (realtimeRequestIdRef.current !== requestId) return;
      setRealtimeError(error instanceof Error ? error.message : String(error));
    } finally {
      if (realtimeRequestIdRef.current === requestId) {
        setIsLoadingRealtime(false);
      }
    }
  }, [member.symbol]);

  const loadIntradayDetail = useCallback(async (options?: { silent?: boolean; forceRefresh?: boolean }) => {
    const requestId = intradayRequestIdRef.current + 1;
    intradayRequestIdRef.current = requestId;
    setIntradayError(null);
    if (!options?.silent) {
      setIsLoadingIntraday(true);
    }
    try {
      const nextDetail = await fetchIntradayBars(member.symbol, { forceRefresh: options?.forceRefresh });
      if (intradayRequestIdRef.current !== requestId) return;
      setIntradayDetail(nextDetail);
    } catch (error) {
      if (intradayRequestIdRef.current !== requestId) return;
      setIntradayError(error instanceof Error ? error.message : String(error));
    } finally {
      if (intradayRequestIdRef.current === requestId) {
        setIsLoadingIntraday(false);
      }
    }
  }, [member.symbol]);

  const refreshRealtimeView = useCallback((options?: { silent?: boolean; forceRefresh?: boolean }) => {
    void loadRealtimeQuote(options);
    void loadIntradayDetail(options);
  }, [loadIntradayDetail, loadRealtimeQuote]);

  const loadDetail = useCallback(async (timeframe: KlineTimeframe) => {
    if (timeframe === "realtime") {
      setDetailTimeframe("realtime");
      setSelectedBarTs(null);
      setDetailError(null);
      return;
    }
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setDetailTimeframe(timeframe);
    setSelectedBarTs(null);
    setDetailError(null);

    const cached = readCachedKlineDetail(member.symbol, timeframe, adjustment);
    if (cached) {
      setDetail(cached);
      setSelectedBarTs(cached.bars.at(-1)?.ts ?? null);
      setIsLoadingDetail(false);
      return;
    }

    setDetail(null);
    setIsLoadingDetail(true);
    try {
      const nextDetail = await loadCachedKlineDetail(member.symbol, timeframe, adjustment);
      if (detailRequestIdRef.current !== requestId) return;
      setDetail(nextDetail);
      setSelectedBarTs(nextDetail.bars.at(-1)?.ts ?? null);
    } catch (error) {
      if (detailRequestIdRef.current !== requestId) return;
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (detailRequestIdRef.current === requestId) {
        setIsLoadingDetail(false);
      }
    }
  }, [adjustment, member.symbol]);

  const loadDividendEvents = useCallback(async () => {
    try {
      setDividendEvents(await loadCachedDividendEvents(member.symbol));
    } catch {
      setDividendEvents([]);
    }
  }, [member.symbol]);

  useEffect(() => {
    void loadDetail(initialTimeframe);
  }, [initialTimeframe, loadDetail]);

  useEffect(() => {
    void loadDividendEvents();
  }, [loadDividendEvents]);

  useEffect(() => {
    if (detailTimeframe !== "realtime") return;
    refreshRealtimeView({ forceRefresh: true });
    const timer = setInterval(() => {
      refreshRealtimeView({ silent: true, forceRefresh: true });
    }, REALTIME_QUOTE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [detailTimeframe, refreshRealtimeView]);

  const isRealtimeView = detailTimeframe === "realtime";
  const isInitialRealtimeLoading =
    (isLoadingRealtime && !realtimeQuote) || (isLoadingIntraday && !intradayDetail);
  const selectedBarIndex = detail
    ? detail.bars.findIndex((bar) => bar.ts === selectedBarTs)
    : -1;
  const resolvedSelectedBarIndex = detail
    ? selectedBarIndex >= 0 ? selectedBarIndex : detail.bars.length - 1
    : -1;
  const selectedBar = detail && resolvedSelectedBarIndex >= 0
    ? detail.bars[resolvedSelectedBarIndex]
    : null;
  const selectedReturnPct = detail && resolvedSelectedBarIndex >= 0
    ? returnPctForBar(detail.bars, resolvedSelectedBarIndex)
    : null;
  const selectedDateLabel = selectedBar ? formatDataDate(selectedBar.ts) : null;
  const metricCards = !isRealtimeView && detail && selectedBar
    ? [
        { label: "收盘", value: formatNumberValue(selectedBar.close) },
        {
          label: "涨跌",
          value: formatSignedPercent(selectedReturnPct),
          className: signedToneClass(selectedReturnPct),
        },
        { label: "开盘", value: formatNumberValue(selectedBar.open) },
        { label: "最高", value: formatNumberValue(selectedBar.high), className: "text-red-600" },
        { label: "最低", value: formatNumberValue(selectedBar.low), className: "text-emerald-600" },
        { label: "振幅", value: formatPercentValue(selectedBar.amplitude) },
        { label: "换手", value: formatPercentValue(selectedBar.turnover) },
        { label: "成交量", value: formatLargeValue(selectedBar.volume, 1) },
        { label: "成交额", value: formatLargeValue(selectedBar.amount, 1) },
        ...MOVING_AVERAGE_CONFIGS.map((config) => ({
          label: config.label,
          value: formatNumberValue(movingAverageAtIndex(detail.bars, config.period, resolvedSelectedBarIndex)),
          className: config.textClass,
        })),
      ]
    : [];

  return (
    <div className="border-t border-slate-100 bg-slate-50/70 p-5">
      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
            <p className="shrink-0 text-sm font-semibold text-slate-950">
              K 线详情
              {!isRealtimeView && selectedDateLabel && (
                <span className="ml-2 align-middle text-xs font-medium text-slate-500">
                  {selectedDateLabel}
                </span>
              )}
            </p>
            {metricCards.length > 0 && (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {metricCards.map((item) => (
                  <div key={item.label} className="inline-flex items-baseline gap-1.5 rounded-md bg-slate-50 px-2.5 py-1.5">
                    <span className="text-[13px] text-slate-500">{item.label}</span>
                    <span className={cn("text-base font-semibold tabular-nums text-slate-950", item.className)}>
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="inline-flex h-9 rounded-md border border-slate-200 bg-slate-50 p-1">
            {KLINE_TIMEFRAMES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  if (option.id !== detailTimeframe) {
                    void loadDetail(option.id);
                  }
                }}
                disabled={isLoadingDetail || isLoadingRealtime || isLoadingIntraday}
                className={cn(
                  "rounded px-3 text-sm font-medium transition-colors",
                  detailTimeframe === option.id
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-500 hover:text-slate-700",
                  (isLoadingDetail || isLoadingRealtime || isLoadingIntraday) && "cursor-wait opacity-70"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {isRealtimeView && isInitialRealtimeLoading ? (
          <div className="flex h-80 items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取实时行情和分时数据...
          </div>
        ) : isRealtimeView ? (
          <div className="space-y-4 p-5">
            {(realtimeError || intradayError) && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                {intradayError ?? realtimeError}
              </div>
            )}
            {intradayDetail ? (
              <IntradayTimeShareChart
                detail={intradayDetail}
                previousClose={realtimeQuote?.previousClose ?? detail?.summary.previousClose}
              />
            ) : (
              <div className="flex h-72 items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
                暂无分时数据
              </div>
            )}
            {realtimeQuote ? (
              <RealtimeQuotePanel
                quote={realtimeQuote}
                member={member}
                isRefreshing={isLoadingRealtime || isLoadingIntraday}
                onRefresh={() => refreshRealtimeView({ forceRefresh: true })}
              />
            ) : (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                暂无实时读数
              </div>
            )}
          </div>
        ) : isLoadingDetail ? (
          <div className="flex h-80 items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取本地 TimescaleDB K 线...
          </div>
        ) : detailError ? (
          <div className="m-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {detailError}
          </div>
        ) : detail ? (
          <div className="p-5">
            <KlineMiniChart
              bars={detail.bars}
              dividendEvents={dividendEvents}
              symbol={member.symbol}
              name={member.name}
              exchange={member.exchange}
              timeframe={detailTimeframe}
              selectedBarTs={selectedBar?.ts ?? null}
              onSelectBar={(bar) => setSelectedBarTs(bar.ts)}
              onResetSelection={() => setSelectedBarTs(detail.bars.at(-1)?.ts ?? null)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function sectorSignalLabel(signal: StrategySectorCapitalFlowItem["signal"]) {
  if (signal === "warming") return "资金升温";
  if (signal === "cooling") return "资金转冷";
  if (signal === "neutral") return "观察";
  return "样本不足";
}

function sectorSignalClass(signal: StrategySectorCapitalFlowItem["signal"]) {
  if (signal === "warming") return "border-red-200 bg-red-50 text-red-700";
  if (signal === "cooling") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (signal === "neutral") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-slate-200 bg-slate-50 text-slate-500";
}

function SectorTrendBars({ detail }: { detail: StrategySectorCapitalFlowDetail }) {
  const maxAmount = Math.max(
    ...detail.trend.map((point) => Math.abs(finiteNumber(point.proxyNetAmount) ?? 0)),
    1
  );
  const visibleTrend = detail.trend.slice(-20);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-950">{detail.sector} 近段资金热度</p>
          <p className="mt-1 text-xs text-slate-500">方向额代理、上涨占比、涨停数按交易日聚合。</p>
        </div>
        <Badge variant="outline" className={sectorSignalClass(detail.item.signal)}>
          {sectorSignalLabel(detail.item.signal)}
        </Badge>
      </div>
      <div className="mt-4 flex h-44 items-end gap-1 overflow-x-auto border-b border-slate-100 pb-2">
        {visibleTrend.map((point) => {
          const net = finiteNumber(point.proxyNetAmount) ?? 0;
          const height = Math.max(6, Math.min(100, Math.abs(net) / maxAmount * 100));
          return (
            <div key={point.tradeDate} className="flex min-w-8 flex-1 flex-col items-center justify-end gap-1">
              <div
                className={cn("w-full rounded-t", net >= 0 ? "bg-red-400" : "bg-emerald-400")}
                style={{ height: `${height}%` }}
                title={`${point.tradeDate} 方向额 ${formatLargeValue(point.proxyNetAmount, 1)} / 上涨 ${formatPercentValue(point.risingRatio)}`}
              />
              <span className="text-[10px] tabular-nums text-slate-400">{point.tradeDate.slice(5)}</span>
            </div>
          );
        })}
        {!visibleTrend.length && (
          <div className="flex h-full flex-1 items-center justify-center text-sm text-slate-500">
            暂无趋势明细
          </div>
        )}
      </div>
    </div>
  );
}

function SectorCapitalFlowView({ data }: { data: StrategyDashboardData }) {
  const primaryUniverse =
    data.research.universes.find((universe) => universe.id === data.research.primaryUniverseId) ??
    data.research.universes.find((universe) => universe.stockCount > 0) ??
    data.research.universes[0] ??
    null;
  const [selectedUniverseId, setSelectedUniverseId] = useState(primaryUniverse?.id ?? data.research.primaryUniverseId);
  const [items, setItems] = useState<StrategySectorCapitalFlowItem[]>([]);
  const [marketSummary, setMarketSummary] = useState<StrategySectorCapitalFlowMarketSummary | null>(null);
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [sectorDetail, setSectorDetail] = useState<StrategySectorCapitalFlowDetail | null>(null);
  const [proxyNote, setProxyNote] = useState("");
  const [cacheStatus, setCacheStatus] = useState("bypass");
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const selectedUniverse =
    data.research.universes.find((universe) => universe.id === selectedUniverseId) ??
    primaryUniverse;

  const loadSectorFlow = useCallback(async () => {
    if (!selectedUniverse) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sector-capital-flow",
          universeId: selectedUniverse.id,
          limit: 50,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "读取板块资金失败");
      }
      setItems((payload.data?.items ?? []) as StrategySectorCapitalFlowItem[]);
      setMarketSummary((payload.data?.marketSummary ?? null) as StrategySectorCapitalFlowMarketSummary | null);
      setProxyNote(String(payload.data?.proxyNote ?? ""));
      setCacheStatus(String(payload.data?.cacheStatus ?? "bypass"));
    } catch (loadError) {
      setItems([]);
      setMarketSummary(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [selectedUniverse]);

  const loadSectorDetail = useCallback(async (sector: string) => {
    if (!selectedUniverse) return;
    setSelectedSector(sector);
    setIsLoadingDetail(true);
    setDetailError(null);
    try {
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sector-capital-flow",
          universeId: selectedUniverse.id,
          limit: 50,
          sector,
          detailDays: 20,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "读取板块详情失败");
      }
      setSectorDetail((payload.data?.detail ?? null) as StrategySectorCapitalFlowDetail | null);
    } catch (loadError) {
      setSectorDetail(null);
      setDetailError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoadingDetail(false);
    }
  }, [selectedUniverse]);

  useEffect(() => {
    setSelectedSector(null);
    setSectorDetail(null);
    void loadSectorFlow();
  }, [loadSectorFlow]);

  const leadingItems = items.slice(0, 6);
  const warmingCount = marketSummary?.warmingCount ?? items.filter((item) => item.signal === "warming").length;
  const totalProxyAmount = marketSummary?.proxyNetAmount ?? items.reduce((sum, item) => sum + (finiteNumber(item.proxyNetAmount) ?? 0), 0);

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-950">板块资金与主力动向</h2>
              <Badge variant="outline" className="bg-white text-slate-500">
                {items.length ? `${items.length} 个板块标签` : "等待数据"}
              </Badge>
              <Badge variant="outline" className="bg-white text-slate-500">
                缓存 {cacheStatus === "redis-hit" ? "Redis" : cacheStatus === "hit" ? "命中" : cacheStatus === "miss" ? "已刷新" : "直读"}
              </Badge>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
            </div>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-600">
              用本地 TimescaleDB 中的板块标签、成交额、换手、上涨占比和 20 日强弱，先构建板块资金热度代理；真实 DDE/主力净流入字段接入后再替换为资金流口径。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.research.universes.filter((universe) => universe.stockCount > 0).map((universe) => (
              <button
                key={universe.id}
                type="button"
                onClick={() => setSelectedUniverseId(universe.id)}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                  selectedUniverse?.id === universe.id
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                )}
              >
                {universe.name}
              </button>
            ))}
            <Button variant="outline" size="sm" onClick={() => void loadSectorFlow()} disabled={isLoading}>
              <RefreshCcw className={cn("h-4 w-4", isLoading && "animate-spin")} />
              刷新
            </Button>
          </div>
        </div>

        {error && (
          <div className="border-b border-amber-100 bg-amber-50 px-5 py-3 text-sm text-amber-700">
            {error}
          </div>
        )}

        <div className="grid gap-3 border-b border-slate-100 px-5 py-4 md:grid-cols-4">
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">升温板块</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-slate-950">{warmingCount}</p>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">全市场方向额代理</p>
            <p className={cn("mt-1 text-xl font-bold tabular-nums", signedToneClass(totalProxyAmount))}>
              {formatLargeValue(totalProxyAmount, 1)}
            </p>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">全市场上涨占比</p>
            <p className={cn("mt-1 text-xl font-bold tabular-nums", signedToneClass((marketSummary?.risingRatio ?? 50) - 50))}>
              {formatPercentValue(marketSummary?.risingRatio)}
            </p>
          </div>
          <div className="rounded-md bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">全市场量能比</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-slate-950">
              {finiteNumber(marketSummary?.amountRatio20d) === null ? "-" : `${formatNumberValue(marketSummary?.amountRatio20d, 2)}x`}
            </p>
          </div>
        </div>

        {marketSummary?.analysis?.length ? (
          <div className="grid gap-3 border-b border-slate-100 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-950">全市场资金流量分析</p>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {marketSummary.analysis.map((line, index) => (
                  <p key={`${line}-${index}`} className="rounded-md bg-white px-3 py-2 text-sm leading-6 text-slate-600">
                    {line}
                  </p>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-950">强弱方向</p>
              <div className="mt-3 grid gap-3 text-sm">
                <div>
                  <span className="text-xs text-slate-400">强势板块</span>
                  <p className="mt-1 text-slate-700">{marketSummary.strongestSectors.join("、") || "-"}</p>
                </div>
                <div>
                  <span className="text-xs text-slate-400">弱势板块</span>
                  <p className="mt-1 text-slate-700">{marketSummary.weakestSectors.join("、") || "-"}</p>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full min-w-[1120px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">板块</th>
                  <th className="px-3 py-3 font-medium">信号</th>
                  <th className="px-3 py-3 font-medium">方向成交额代理</th>
                  <th className="px-3 py-3 font-medium">最新成交额</th>
                  <th className="px-3 py-3 font-medium">量能比</th>
                  <th className="px-3 py-3 font-medium">上涨占比</th>
                  <th className="px-3 py-3 font-medium">20日强弱</th>
                  <th className="px-3 py-3 font-medium">换手</th>
                  <th className="px-3 py-3 font-medium">样本</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => (
                  <tr
                    key={item.sector}
                    onClick={() => void loadSectorDetail(item.sector)}
                    className={cn(
                      "cursor-pointer align-top transition-colors hover:bg-slate-50",
                      selectedSector === item.sector && "bg-blue-50/70"
                    )}
                  >
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-950">{item.sector}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        {item.coveredCount}/{item.memberCount} 已覆盖 · 涨停 {item.limitUpCount} · 跌停 {item.limitDownCount}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant="outline" className={sectorSignalClass(item.signal)}>
                        {sectorSignalLabel(item.signal)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3">
                      <p className={cn("font-semibold tabular-nums", signedToneClass(item.proxyNetAmount))}>
                        {formatLargeValue(item.proxyNetAmount, 1)}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        净额占比 {formatPercentValue(item.netAmountRatio)}
                      </p>
                    </td>
                    <td className="px-3 py-3 font-semibold tabular-nums text-slate-900">
                      {formatLargeValue(item.latestAmount, 1)}
                    </td>
                    <td className="px-3 py-3 font-semibold tabular-nums text-slate-900">
                      {finiteNumber(item.amountRatio20d) === null ? "-" : `${formatNumberValue(item.amountRatio20d, 2)}x`}
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-semibold tabular-nums text-slate-900">{formatPercentValue(item.risingRatio)}</p>
                      <p className="mt-1 text-xs text-slate-400">{item.risingCount} 涨 / {item.fallingCount} 跌</p>
                    </td>
                    <td className={cn("px-3 py-3 font-semibold tabular-nums", signedToneClass(item.strength20dPct))}>
                      {formatSignedPercent(item.strength20dPct)}
                    </td>
                    <td className="px-3 py-3 font-semibold tabular-nums text-slate-900">
                      {formatPercentValue(item.avgTurnover20d)}
                    </td>
                    <td className="px-3 py-3">
                      <p className="line-clamp-2 max-w-[220px] text-xs leading-5 text-slate-500">
                        {item.topSymbols.join("、") || "-"}
                      </p>
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={9} className="px-5 py-12 text-center text-sm text-slate-500">
                      {isLoading ? "正在读取板块资金代理..." : "暂无板块资金数据"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <aside className="space-y-3">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-950">如何探查主力资金</p>
              <div className="mt-3 space-y-3 text-sm leading-6 text-slate-600">
                <p><span className="font-semibold text-slate-900">先看板块：</span>板块内多数股票上涨、成交额放大且 20 日强弱转正，说明资金不是孤立拉一只票。</p>
                <p><span className="font-semibold text-slate-900">再看龙头：</span>涨停数、成交额排名和强弱排名同步靠前，才更像主动资金聚集。</p>
                <p><span className="font-semibold text-slate-900">最后看连续性：</span>DDE/主力净流入至少观察 3 日，单日大额流入可能是对倒或出货。</p>
              </div>
            </div>
            <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">当前口径说明</p>
              <p className="mt-2 text-sm leading-6 text-amber-800">
                {proxyNote || "当前为成交额、换手、上涨占比和20日强弱聚合出的资金热度代理，不是 DDE/主力净流入真实字段。"}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-950">后续真实字段</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {["主力净流入", "超大单净额", "大单净额", "DDE 大单金额", "DDE 大单净量", "3/5日资金连续性"].map((item) => (
                  <Badge key={item} variant="outline" className="border-blue-100 bg-blue-50 text-blue-700">
                    {item}
                  </Badge>
                ))}
              </div>
            </div>
          </aside>
        </div>

        {(selectedSector || isLoadingDetail || detailError) && (
          <div className="border-t border-slate-100 px-5 py-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">板块详情</p>
                <p className="mt-1 text-sm text-slate-500">
                  {selectedSector ? `当前查看：${selectedSector}` : "点击任一板块查看资金热度趋势和龙头贡献。"}
                </p>
              </div>
              {isLoadingDetail && (
                <span className="inline-flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在读取板块详情
                </span>
              )}
            </div>
            {detailError && (
              <div className="mb-4 rounded-md border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                {detailError}
              </div>
            )}
            {sectorDetail && (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
                <SectorTrendBars detail={sectorDetail} />
                <div className="space-y-4">
                  <div className="rounded-lg border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-950">详情解读</p>
                    <div className="mt-3 space-y-2">
                      {sectorDetail.analysis.map((line, index) => (
                        <p key={`${line}-${index}`} className="text-sm leading-6 text-slate-600">{line}</p>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-950">成交额贡献靠前</p>
                    <div className="mt-3 space-y-2">
                      {sectorDetail.topMembers.slice(0, 8).map((member) => (
                        <div key={member.symbol} className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm">
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-900">{member.name ?? member.symbol}</p>
                            <p className="font-mono text-xs text-slate-400">{member.symbol}</p>
                          </div>
                          <div className="text-right">
                            <p className={cn("font-semibold tabular-nums", signedToneClass(member.latestChangePercent))}>
                              {formatSignedPercent(member.latestChangePercent)}
                            </p>
                            <p className="text-xs tabular-nums text-slate-500">{formatLargeValue(member.latestAmount, 1)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {leadingItems.length > 0 && (
          <div className="border-t border-slate-100 px-5 py-4">
            <p className="text-sm font-semibold text-slate-900">当前最值得关注的板块</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {leadingItems.map((item) => (
                <div key={item.sector} className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-950">{item.sector}</p>
                    <Badge variant="outline" className={sectorSignalClass(item.signal)}>
                      {sectorSignalLabel(item.signal)}
                    </Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate-400">方向额</span>
                      <p className={cn("font-semibold tabular-nums", signedToneClass(item.proxyNetAmount))}>
                        {formatLargeValue(item.proxyNetAmount, 1)}
                      </p>
                    </div>
                    <div>
                      <span className="text-slate-400">强弱</span>
                      <p className={cn("font-semibold tabular-nums", signedToneClass(item.strength20dPct))}>
                        {formatSignedPercent(item.strength20dPct)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function factorCatalogStatusLabel(status: StrategyFactorCatalogItem["status"]) {
  if (status === "ready") return "可计算";
  if (status === "partial") return "部分可用";
  return "需补数据";
}

function factorCatalogStatusClass(status: StrategyFactorCatalogItem["status"]) {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-blue-200 bg-blue-50 text-blue-700";
}

function factorDirectionLabel(direction: StrategyFactorCatalogItem["direction"]) {
  if (direction === "higher_is_better") return "越高越好";
  if (direction === "lower_is_better") return "越低越好";
  if (direction === "middle_is_better") return "适中最好";
  return "事件驱动";
}

const FACTOR_PAGE_SIZE = 4;
type FactorStatusFilter = "all" | StrategyFactorCatalogItem["status"];

const FACTOR_STATUS_FILTERS: Array<{ id: FactorStatusFilter; label: string }> = [
  { id: "all", label: "全部质量" },
  { id: "ready", label: "可计算" },
  { id: "partial", label: "部分可用" },
  { id: "needs_data", label: "需补数据" },
];

function FactorCatalogView({ data }: { data: StrategyDashboardData }) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<FactorStatusFilter>("all");
  const [factorPage, setFactorPage] = useState(1);
  const factorEntries = useMemo(() => (
    data.factorCatalog.categories.flatMap((category) => (
      category.factors.map((factor) => ({
        category,
        factor,
      }))
    ))
  ), [data.factorCatalog.categories]);
  const allFactors = factorEntries.map((entry) => entry.factor);
  const filteredEntries = useMemo(() => (
    factorEntries.filter(({ category, factor }) => (
      (categoryFilter === "all" || category.id === categoryFilter) &&
      (statusFilter === "all" || factor.status === statusFilter)
    ))
  ), [categoryFilter, factorEntries, statusFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / FACTOR_PAGE_SIZE));
  const safePage = Math.min(factorPage, totalPages);
  const pageStart = (safePage - 1) * FACTOR_PAGE_SIZE;
  const pageEntries = filteredEntries.slice(pageStart, pageStart + FACTOR_PAGE_SIZE);
  const pagedCategoryGroups = data.factorCatalog.categories
    .map((category) => ({
      category,
      factors: pageEntries
        .filter((entry) => entry.category.id === category.id)
        .map((entry) => entry.factor),
      total: filteredEntries.filter((entry) => entry.category.id === category.id).length,
    }))
    .filter((group) => group.factors.length > 0);
  const readyCount = allFactors.filter((factor) => factor.status === "ready").length;
  const partialCount = allFactors.filter((factor) => factor.status === "partial").length;
  const needsDataCount = allFactors.filter((factor) => factor.status === "needs_data").length;
  const topPriorityFactors = allFactors
    .slice()
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, 6);
  const sourceFrameworks = Array.from(new Set(allFactors.flatMap((factor) => factor.sourceFrameworks))).slice(0, 12);
  const pageEnd = filteredEntries.length ? Math.min(pageStart + pageEntries.length, filteredEntries.length) : 0;

  useEffect(() => {
    setFactorPage(1);
  }, [categoryFilter, statusFilter]);

  useEffect(() => {
    if (factorPage > totalPages) setFactorPage(totalPages);
  }, [factorPage, totalPages]);

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-4xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-950">因子目录</h2>
              <Badge variant="outline" className="bg-white text-slate-500">{allFactors.length} 个因子</Badge>
              <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{readyCount} 个可计算</Badge>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              因子目录记录策略平台已经沉淀的因子公式、数据依赖、适用场景和补数缺口。它用于连接股票池、策略模板、回测和后续自动选股。
            </p>
          </div>
          <div className="grid min-w-[320px] grid-cols-3 gap-2">
            {[
              { label: "可计算", value: readyCount, className: "text-emerald-700" },
              { label: "部分可用", value: partialCount, className: "text-amber-700" },
              { label: "需补数据", value: needsDataCount, className: "text-blue-700" },
            ].map((item) => (
              <div key={item.label} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500">{item.label}</p>
                <p className={cn("mt-1 text-xl font-bold tabular-nums", item.className)}>{item.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="rounded-md border border-slate-200 bg-slate-50/70 p-4">
            <p className="text-sm font-semibold text-slate-950">研究方法</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {data.factorCatalog.methodology.map((item) => (
                <div key={item} className="flex gap-2 rounded-md bg-white px-3 py-2 text-sm leading-6 text-slate-600">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-md border border-blue-100 bg-blue-50/70 p-4">
            <p className="text-sm font-semibold text-blue-950">参考框架</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {sourceFrameworks.map((framework) => (
                <Badge key={framework} variant="outline" className="border-blue-100 bg-white text-blue-700">
                  {framework}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-950">数据 → 因子 → 策略</h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              研究顺序固定为先确认数据，再设计因子，最后组合策略；任何一步质量门没过，都不进入下一步。
            </p>
          </div>
          <Badge variant="outline" className="bg-white text-slate-500">研究协议</Badge>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {data.factorCatalog.workflow.map((step) => (
            <article key={step.id} className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-md bg-white px-2.5 py-1 font-mono text-xs font-semibold text-blue-700 shadow-sm">
                  {step.stage}
                </span>
                <span className="text-xs font-medium text-slate-400">{step.id}</span>
              </div>
              <h4 className="mt-3 text-sm font-bold text-slate-950">{step.title}</h4>
              <p className="mt-2 text-sm leading-6 text-slate-600">{step.objective}</p>
              <div className="mt-3 grid gap-2">
                <div>
                  <p className="text-[11px] font-semibold text-slate-400">输入</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{step.inputs.join("、")}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-slate-400">输出</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{step.outputs.join("、")}</p>
                </div>
                <div className="rounded-md border border-amber-100 bg-amber-50 px-3 py-2">
                  <p className="text-[11px] font-semibold text-amber-700">质量门</p>
                  <p className="mt-1 text-xs leading-5 text-amber-900">{step.qualityGate}</p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(420px,0.8fr)]">
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">从数据层思考因子</h3>
              <p className="mt-1 text-sm text-slate-500">每个数据层都要明确能直接产出哪些因子，以及当前还缺什么。</p>
            </div>
            <Badge variant="outline" className="bg-white text-slate-500">{data.factorCatalog.dataLayers.length} 层</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">数据层</th>
                  <th className="px-4 py-3 font-medium">现有数据</th>
                  <th className="px-4 py-3 font-medium">可派生因子</th>
                  <th className="px-4 py-3 font-medium">缺口与动作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.factorCatalog.dataLayers.map((layer) => (
                  <tr key={layer.id} className="align-top">
                    <td className="w-[220px] px-4 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-950">{layer.name}</p>
                        <Badge variant="outline" className={factorCatalogStatusClass(layer.status)}>
                          {factorCatalogStatusLabel(layer.status)}
                        </Badge>
                        <Badge variant="outline" className="bg-white text-slate-500">{layer.priority}</Badge>
                      </div>
                      <div className="mt-2 space-y-1">
                        {layer.tables.map((table) => (
                          <code key={`${layer.id}-${table}`} className="block rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">
                            {table}
                          </code>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        {layer.availableData.map((item) => (
                          <span key={`${layer.id}-available-${item}`} className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                            {item}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        {layer.factorIdeas.map((item) => (
                          <span key={`${layer.id}-factor-${item}`} className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                            {item}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1.5">
                          {layer.dataGaps.map((item) => (
                            <span key={`${layer.id}-gap-${item}`} className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                              {item}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs leading-5 text-slate-500">{layer.nextAction}</p>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-slate-950">由因子组合策略</h3>
            <p className="mt-1 text-sm text-slate-500">策略先作为蓝图存在，验证通过后再进入策略目录。</p>
          </div>
          <div className="max-h-[640px] space-y-3 overflow-y-auto p-4">
            {data.factorCatalog.strategyBlueprints.map((blueprint) => (
              <article key={blueprint.id} className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-slate-950">{blueprint.name}</h4>
                    <p className="mt-1 text-xs text-slate-400">{blueprint.horizon}</p>
                  </div>
                  <Badge variant="outline" className={factorCatalogStatusClass(blueprint.status)}>
                    {factorCatalogStatusLabel(blueprint.status)}
                  </Badge>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-600">{blueprint.strategyIdea}</p>
                <div className="mt-3">
                  <p className="text-[11px] font-semibold text-slate-400">因子输入</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {blueprint.factorInputs.map((item) => (
                      <span key={`${blueprint.id}-input-${item}`} className="rounded bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700">
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="mt-3 grid gap-2">
                  <div>
                    <p className="text-[11px] font-semibold text-slate-400">验证路径</p>
                    <div className="mt-1 space-y-1 text-xs leading-5 text-slate-600">
                      {blueprint.validationPath.map((item) => <p key={`${blueprint.id}-validation-${item}`}>{item}</p>)}
                    </div>
                  </div>
                  <div className="rounded-md border border-amber-100 bg-amber-50 px-3 py-2">
                    <p className="text-[11px] font-semibold text-amber-700">风控约束</p>
                    <div className="mt-1 space-y-1 text-xs leading-5 text-amber-900">
                      {blueprint.riskControls.map((item) => <p key={`${blueprint.id}-risk-${item}`}>{item}</p>)}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-950">因子筛选</h3>
            <p className="mt-1 text-sm text-slate-500">
              先按因子家族定位研究方向，再按落地质量查看当前能否直接参与选股和回测。
            </p>
          </div>
          <Badge variant="outline" className="bg-white text-slate-500">
            {filteredEntries.length} / {allFactors.length} 个
          </Badge>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <div>
            <p className="text-xs font-semibold text-slate-400">因子家族</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCategoryFilter("all")}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                  categoryFilter === "all"
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                )}
              >
                全部
                <span className="ml-1.5 text-xs tabular-nums text-slate-400">{allFactors.length}</span>
              </button>
              {data.factorCatalog.categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setCategoryFilter(category.id)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    categoryFilter === category.id
                      ? "border-blue-200 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  )}
                >
                  {category.name}
                  <span className="ml-1.5 text-xs tabular-nums text-slate-400">{category.factors.length}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-400">落地质量</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {FACTOR_STATUS_FILTERS.map((item) => {
                const count = item.id === "all"
                  ? allFactors.length
                  : allFactors.filter((factor) => factor.status === item.id).length;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setStatusFilter(item.id)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                      statusFilter === item.id
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    )}
                  >
                    {item.label}
                    <span className={cn(
                      "ml-1.5 text-xs tabular-nums",
                      statusFilter === item.id ? "text-white/70" : "text-slate-400"
                    )}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-sm text-slate-500">
              显示 <span className="font-semibold tabular-nums text-slate-900">{filteredEntries.length ? pageStart + 1 : 0}</span>
              {" - "}
              <span className="font-semibold tabular-nums text-slate-900">{pageEnd}</span>
              {" / "}
              <span className="font-semibold tabular-nums text-slate-900">{filteredEntries.length}</span>
              {" 个因子，每页 "}
              <span className="font-semibold tabular-nums text-slate-900">{FACTOR_PAGE_SIZE}</span>
              {" 个"}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFactorPage((page) => Math.max(1, page - 1))}
                disabled={safePage <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
                上一页
              </Button>
              <span className="min-w-20 text-center text-sm tabular-nums text-slate-500">
                {safePage} / {totalPages}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFactorPage((page) => Math.min(totalPages, page + 1))}
                disabled={safePage >= totalPages}
              >
                下一页
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {pagedCategoryGroups.map(({ category, factors, total }) => (
            <section key={category.id} className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-950">{category.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-500">{category.description}</p>
                </div>
                <Badge variant="outline" className="bg-white text-slate-500">{factors.length} / {total} 个</Badge>
              </div>
              <div className="divide-y divide-slate-100">
                {factors.map((factor) => (
                  <article key={factor.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-bold text-slate-950">{factor.name}</h4>
                          <Badge variant="outline" className={factorCatalogStatusClass(factor.status)}>
                            {factorCatalogStatusLabel(factor.status)}
                          </Badge>
                          <Badge variant="outline" className="bg-slate-50 text-slate-500">
                            {factorDirectionLabel(factor.direction)}
                          </Badge>
                          <Badge variant="outline" className="bg-white text-slate-500">
                            优先级 {factor.priority}
                          </Badge>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-slate-600">{factor.rationale}</p>
                      </div>
                      <p className="rounded-md bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-500">
                        {factor.horizon}
                      </p>
                    </div>

                    <code className="mt-4 block rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs leading-5 text-slate-700">
                      {factor.formula}
                    </code>

                    <div className="mt-4 grid gap-3 lg:grid-cols-4">
                      <div className="rounded-md bg-emerald-50 p-3">
                        <p className="text-xs font-semibold text-emerald-700">当前可用数据</p>
                        <div className="mt-2 space-y-1 text-xs leading-5 text-emerald-900">
                          {factor.currentData.length
                            ? factor.currentData.map((item) => <p key={`${factor.id}-current-${item}`}>{item}</p>)
                            : <p>暂无</p>}
                        </div>
                      </div>
                      <div className="rounded-md bg-amber-50 p-3">
                        <p className="text-xs font-semibold text-amber-700">缺口</p>
                        <div className="mt-2 space-y-1 text-xs leading-5 text-amber-900">
                          {factor.missingData.length
                            ? factor.missingData.map((item) => <p key={`${factor.id}-missing-${item}`}>{item}</p>)
                            : <p>无关键缺口</p>}
                        </div>
                      </div>
                      <div className="rounded-md bg-blue-50 p-3">
                        <p className="text-xs font-semibold text-blue-700">适用场景</p>
                        <div className="mt-2 space-y-1 text-xs leading-5 text-blue-950">
                          {factor.useCases.map((item) => <p key={`${factor.id}-use-${item}`}>{item}</p>)}
                        </div>
                      </div>
                      <div className="rounded-md bg-slate-50 p-3">
                        <p className="text-xs font-semibold text-slate-500">护栏</p>
                        <div className="mt-2 space-y-1 text-xs leading-5 text-slate-700">
                          {factor.guardrails.map((item) => <p key={`${factor.id}-guard-${item}`}>{item}</p>)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2">
                      <p className="text-xs font-semibold text-slate-500">落地动作</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {factor.enrichmentPlan.map((item) => (
                          <span key={`${factor.id}-plan-${item}`} className="rounded-md bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
          {!filteredEntries.length && (
            <EmptyState title="没有匹配的因子" description="调整因子家族或落地质量筛选条件" className="border-0" />
          )}

          {filteredEntries.length > FACTOR_PAGE_SIZE && (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFactorPage((page) => Math.max(1, page - 1))}
                disabled={safePage <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
                上一页
              </Button>
              <span className="min-w-20 text-center text-sm tabular-nums text-slate-500">
                {safePage} / {totalPages}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFactorPage((page) => Math.min(totalPages, page + 1))}
                disabled={safePage >= totalPages}
              >
                下一页
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-slate-950">优先落地因子</p>
            <div className="mt-3 space-y-2">
              {topPriorityFactors.map((factor) => (
                <div key={`priority-${factor.id}`} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">{factor.name}</p>
                    <Badge variant="outline" className={factorCatalogStatusClass(factor.status)}>
                      {factorCatalogStatusLabel(factor.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{factor.category} · {factor.horizon}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-slate-950">数据补充路线</p>
            <div className="mt-3 space-y-3">
              {data.factorCatalog.enrichmentPlan.map((item) => (
                <div key={item.id} className="rounded-md border border-slate-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">{item.currentGap}</p>
                    </div>
                    <Badge variant="outline" className={
                      item.priority === "P0"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : item.priority === "P1"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-slate-200 bg-slate-50 text-slate-600"
                    }>
                      {item.priority}
                    </Badge>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div>
                      <p className="text-[11px] font-semibold text-slate-400">目标表</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {item.targetTables.map((table) => (
                          <code key={`${item.id}-table-${table}`} className="rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">
                            {table}
                          </code>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-slate-400">可选来源</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {item.providerOptions.map((provider) => (
                          <span key={`${item.id}-provider-${provider}`} className="rounded bg-blue-50 px-2 py-1 text-[11px] text-blue-700">
                            {provider}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-slate-400">解锁能力</p>
                      <div className="mt-1 space-y-1 text-xs leading-5 text-slate-600">
                        {item.unlocks.map((unlock) => <p key={`${item.id}-unlock-${unlock}`}>{unlock}</p>)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-amber-100 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">使用边界</p>
            <p className="mt-2 text-sm leading-6 text-amber-800">
              因子用于排序、过滤和回测假设，不直接等价于投资建议。缺数据的因子必须保持 needs_data 状态，不能用空值或 0 填充通过验证。
            </p>
          </section>
        </aside>
      </section>
    </div>
  );
}

type FinancialWikiPageType = "concept" | "indicator" | "workflow" | "risk" | "source";

type FinancialWikiPage = {
  id: string;
  title: string;
  type: FinancialWikiPageType;
  domain: string;
  summary: string;
  formula?: string;
  decisionUse: string;
  sources: string[];
  links: string[];
  qualityGate: string;
  caveats: string[];
};

type FinancialWikiCollection = {
  id: string;
  name: string;
  description: string;
  pages: string[];
};

const FINANCIAL_WIKI_PAGE_TYPE_LABELS: Record<FinancialWikiPageType, string> = {
  concept: "概念",
  indicator: "指标",
  workflow: "流程",
  risk: "风控",
  source: "数据源",
};

const FINANCIAL_WIKI_PURPOSE = {
  title: "QuantPilot 金融知识库",
  statement:
    "把策略平台反复用到的行情、因子、资金流、交易规则和风控知识整理成可追溯 Wiki，供策略目录、因子目录、Agent 生成和人工复核共同引用。",
  scope: [
    "A 股股票、ETF、指数的行情与策略研究口径",
    "选股、买卖价格、参数扫描、回测和数据质量检查",
    "本地 market-data 服务可验证的数据字段与外部源限制",
  ],
  questions: [
    "这个概念依赖哪些字段，字段当前是否可用？",
    "它如何影响选股、买入、卖出或风控？",
    "它有哪些常见误用，是否需要数据源口径隔离？",
    "它和哪些策略模板、因子或基础组件互相引用？",
  ],
} as const;

const FINANCIAL_WIKI_SCHEMA_RULES = [
  "每个页面必须有 frontmatter：type、domain、status、sources、updatedBy、qualityGate。",
  "指标页面必须写明 formula、字段依赖、复权/时区/交易日口径和缺失值处理。",
  "策略相关页面必须链接到至少一个风险页面或数据质量页面。",
  "不能把外部源口径不同的字段直接混排；必须保留 provider、as_of、fetched_at。",
  "页面之间用 [[页面标题]] 交叉引用，孤立页面进入 Lint 待补链接队列。",
] as const;

const FINANCIAL_WIKI_OPERATIONS = [
  {
    id: "ingest",
    title: "Ingest 摄入",
    description: "读取 API 文档、因子定义、策略模板和外部资料，先形成结构化分析，再生成或更新 Wiki 页面。",
    checks: ["提取实体与指标", "记录来源和字段", "建议 wikilinks", "写入 log.md"],
  },
  {
    id: "query",
    title: "Query 查询",
    description: "按关键词、页面类型和图谱关联组装上下文，用编号页面回答策略问题。",
    checks: ["先搜 index.md", "再扩展相关页面", "预算内保留公式和边界", "回答引用页面编号"],
  },
  {
    id: "lint",
    title: "Lint 检查",
    description: "检查页面结构、缺失来源、断链、口径冲突和过期数据，生成待人工处理项。",
    checks: ["frontmatter 完整", "sources 可追溯", "无孤立页面", "质量门明确"],
  },
] as const;

const FINANCIAL_WIKI_PAGES: FinancialWikiPage[] = [
  {
    id: "market-data-contract",
    title: "行情数据契约",
    type: "source",
    domain: "数据源",
    summary:
      "定义行情响应必须包含 asset_type、source、as_of、fetched_at、currency、timezone、fetch 和 data_quality，避免页面只读价格而丢失来源上下文。",
    decisionUse:
      "任何策略、图表或 Agent 输出在展示行情时，都要同步展示来源、时间和质量状态；缺失字段不能静默置零。",
    sources: ["services/market-data/README.md", "/api/v1/quotes/realtime", "/api/v1/quotes/history"],
    links: ["[[回测样本完整性]]", "[[复权与交易日口径]]", "[[成交额与流动性]]"],
    qualityGate: "响应中 source、as_of、fetched_at、data_quality.status 至少四项完整。",
    caveats: ["浏览器页面优先走同源 /api/market 代理", "外部源失败时要标注 degraded", "缓存命中不代表数据已过期"],
  },
  {
    id: "adjustment-calendar",
    title: "复权与交易日口径",
    type: "concept",
    domain: "行情基础",
    summary:
      "日线、周线、月线和回测必须统一复权口径；A 股交易日以本地交易日历或已入库 K 线推断为准。",
    formula: "前复权 qfq 用于趋势与回测；不复权 none 用于盘中和原始价格检查。",
    decisionUse:
      "均线、收益率、回撤、ATR 和突破信号在复权口径不一致时会失真，策略扫描前必须固定 adjustment。",
    sources: ["quant.stock_bars", "/api/v1/foundation/trading-calendar", "/api/v1/quotes/history/{symbol}"],
    links: ["[[移动均线 MA]]", "[[ATR 真实波幅]]", "[[行情数据契约]]"],
    qualityGate: "同一策略模板只允许一个 timeframe + adjustment 组合进入回测。",
    caveats: ["分红除权会影响历史价格", "指数/ETF/股票可能适用不同默认口径", "节假日不能用自然日推断样本间隔"],
  },
  {
    id: "moving-average",
    title: "移动均线 MA",
    type: "indicator",
    domain: "趋势",
    summary:
      "MA5/10 反映短线成本，MA20/30 反映月度趋势，MA60 更接近中期趋势，是趋势过滤和持仓跟踪的基础页面。",
    formula: "MA(N) = 最近 N 个交易日收盘价之和 / N",
    decisionUse:
      "股价在 MA5 上方且 MA5 > MA10 > MA20 > MA30 > MA60，通常说明短中期成本逐级抬升，可作为趋势选股过滤。",
    sources: ["quant.stock_bars.close", "/api/v1/indicators/technical/{symbol}"],
    links: ["[[复权与交易日口径]]", "[[涨停/跌停制度]]", "[[回撤与收益风险比]]"],
    qualityGate: "至少 60 根同一复权口径 K 线可用，否则 MA60 不进入判断。",
    caveats: ["均线滞后", "震荡市容易反复假信号", "不同复权口径不可混用"],
  },
  {
    id: "dde-order-flow",
    title: "DDE 大单金额",
    type: "indicator",
    domain: "资金流",
    summary:
      "衡量大资金在某只股票上的净流入方向；不同数据源对“大单”的阈值会不同，落库时必须保留 provider 和 raw_payload。",
    formula: "大单买入金额 - 大单卖出金额",
    decisionUse:
      "连续为正通常代表资金承接更强，适合与涨停、均线多头、放量一起使用；单日转负可作为接力策略降权或退出信号。",
    sources: ["待接入 DDE provider", "quant.stock_factors.capital_flow_*"],
    links: ["[[板块资金热度代理]]", "[[成交额与流动性]]", "[[涨停/跌停制度]]"],
    qualityGate: "同一 provider、同一粒度、连续 3 个交易日以上才允许参与排序。",
    caveats: ["不要只看单日", "必须看成交额覆盖", "需要区分日终数据和盘中快照"],
  },
  {
    id: "sector-flow-proxy",
    title: "板块资金热度代理",
    type: "workflow",
    domain: "资金流",
    summary:
      "在真实 DDE/主力净流入字段接入前，用板块内成交额、换手、上涨占比、涨停数和 20 日强弱构建资金热度代理。",
    formula: "proxyNetAmount = Σ(成交额 × 涨跌方向权重)",
    decisionUse:
      "先判断资金是否在板块层面共振，再下钻龙头；避免只因为单只股票异动就误判为主线行情。",
    sources: ["/api/v1/research/screeners/a-share/short-term-candidates", "/api/v1/research/bars/{symbol}", "sector tags"],
    links: ["[[DDE 大单金额]]", "[[成交额与流动性]]", "[[涨停/跌停制度]]"],
    qualityGate: "板块样本至少 5 只且覆盖率超过 60%，否则只展示观察状态。",
    caveats: ["这是资金热度代理，不是真实 DDE", "板块标签稀疏会影响聚合", "单日热度不能替代连续性"],
  },
  {
    id: "turnover-liquidity",
    title: "成交额与流动性",
    type: "indicator",
    domain: "流动性",
    summary:
      "成交额比成交量更适合跨价格区间比较流动性，换手率反映筹码交换程度，两者共同决定策略是否可交易。",
    formula: "成交额 = 成交价格 × 成交量；换手率 = 成交量 / 流通股本 × 100%",
    decisionUse:
      "成交额不足的股票，即使命中 DDE 或均线条件，也可能无法承载实际交易规模；极端换手叠加放量阴线需降权。",
    sources: ["quant.stock_bars.amount", "quant.stock_bars.turnover", "quant.stock_bars.volume"],
    links: ["[[DDE 大单金额]]", "[[ATR 真实波幅]]", "[[回测样本完整性]]"],
    qualityGate: "20 日平均成交额和换手率至少一项可用，缺失时不参与流动性排序。",
    caveats: ["放量也可能是出货", "低成交额样本回测容易虚高", "新股和小盘股需单独阈值"],
  },
  {
    id: "limit-up-down",
    title: "涨停/跌停制度",
    type: "concept",
    domain: "交易规则",
    summary:
      "主板、创业板、科创板、北交所、ST 的涨跌幅限制不同，策略里要明确剔除、分层或单独设置阈值。",
    formula: "涨停价 ≈ 前收盘价 × (1 + 涨跌幅限制)",
    decisionUse:
      "近 4 日涨停至少 1 次说明短线情绪被激活；当日已经涨停则可能无法合理买入，应标记不可成交。",
    sources: ["quant.stock_bars.limit_up", "quant.stock_bars.limit_down", "quant.stock_bars.is_st"],
    links: ["[[移动均线 MA]]", "[[开盘强弱与回踩承接]]", "[[成交额与流动性]]"],
    qualityGate: "必须识别 ST、停牌、涨停、跌停和市场板块，避免错误计算可成交性。",
    caveats: ["涨停不等于可以买到", "一字板需要盘口数据", "涨跌幅制度随市场板块变化"],
  },
  {
    id: "gap-open-support",
    title: "开盘强弱与回踩承接",
    type: "indicator",
    domain: "买卖价格",
    summary:
      "高开代表情绪延续，回踩前收、MA5 或关键价位不破代表承接较强，是短线买点设计的重要页面。",
    formula: "开盘涨幅 = (今日开盘价 - 昨日收盘价) / 昨日收盘价 × 100%",
    decisionUse:
      "涨停次日策略里，开盘价大于昨收是强势条件；高开过多则成本失控，需要等待回踩或放弃。",
    sources: ["quant.stock_bars.open", "quant.stock_bars.previous_close", "minute1 intraday"],
    links: ["[[涨停/跌停制度]]", "[[ATR 真实波幅]]", "[[回撤与收益风险比]]"],
    qualityGate: "日线可给粗判断；真实承接必须接入分钟线或集合竞价金额。",
    caveats: ["高开过多会降低收益风险比", "日线无法判断盘中承接", "集合竞价金额很关键"],
  },
  {
    id: "atr-volatility",
    title: "ATR 真实波幅",
    type: "indicator",
    domain: "波动",
    summary:
      "ATR 衡量标的近期正常波动范围，比简单涨跌幅更适合做止损、买入区间和追高上限。",
    formula: "TR = max(高 - 低, |高 - 昨收|, |低 - 昨收|)；ATR = TR 的 N 日均值",
    decisionUse:
      "买入价、止损价、追高上限可以用 ATR 反推，例如止损距离 1.2 ATR，止盈至少 2R。",
    sources: ["quant.stock_bars.high", "quant.stock_bars.low", "quant.stock_bars.close"],
    links: ["[[回撤与收益风险比]]", "[[开盘强弱与回踩承接]]", "[[成交额与流动性]]"],
    qualityGate: "至少 14 根连续 K 线可用；低价股优先使用 ATR 百分比。",
    caveats: ["突发事件会抬高 ATR", "ATR 不能替代流动性检查", "波动扩张不必然代表趋势"],
  },
  {
    id: "risk-r-multiple",
    title: "回撤与收益风险比",
    type: "risk",
    domain: "风控",
    summary:
      "把买入、止损、止盈统一成可比较的风险单位，避免只看涨幅不看亏损，是策略输出必须附带的风险页面。",
    formula: "R = 买入价 - 止损价；收益风险比 = (目标价 - 买入价) / R",
    decisionUse:
      "买入前先算止损，至少看到 2R 空间再考虑入场；达到 2R 可先减仓，再用均线或 ATR 跟踪。",
    sources: ["strategy templates", "backtest metrics", "quant.stock_bars.close"],
    links: ["[[ATR 真实波幅]]", "[[移动均线 MA]]", "[[回测样本完整性]]"],
    qualityGate: "策略工作空间必须同时输出买入价、止损价、目标价和放弃条件。",
    caveats: ["止损不能事后移动放宽", "目标价不应凭感觉设置", "滑点会降低真实收益风险比"],
  },
  {
    id: "backtest-integrity",
    title: "回测样本完整性",
    type: "risk",
    domain: "回测",
    summary:
      "回测前检查 K 线缺口、复权口径、成交额、停牌/ST、涨跌停和字段增强状态，避免样本质量问题伪造收益。",
    decisionUse:
      "只有通过数据质量扫描的标的才进入参数扫描；缺字段策略必须保持 planned 或 needs_data 状态。",
    sources: ["/api/v1/foundation/data-quality/scan", "strategyScanRun", "strategyScanJob"],
    links: ["[[行情数据契约]]", "[[复权与交易日口径]]", "[[成交额与流动性]]"],
    qualityGate: "错误级问题为 0，警告项必须在页面中显式展示。",
    caveats: ["低流动性样本回测可能虚高", "不能用 0 替代缺失值", "参数扫描要控制过拟合"],
  },
] as const;

const FINANCIAL_WIKI_COLLECTIONS: FinancialWikiCollection[] = [
  {
    id: "foundation",
    name: "基础口径",
    description: "先确认数据契约、复权、交易日和行情质量，再谈指标。",
    pages: ["market-data-contract", "adjustment-calendar", "backtest-integrity"],
  },
  {
    id: "signals",
    name: "信号与因子",
    description: "趋势、资金流、流动性、波动和开盘强弱的计算与误用边界。",
    pages: ["moving-average", "dde-order-flow", "turnover-liquidity", "gap-open-support", "atr-volatility"],
  },
  {
    id: "strategy",
    name: "策略与风控",
    description: "把信号组合成可执行策略，并用收益风险比和样本完整性约束。",
    pages: ["sector-flow-proxy", "limit-up-down", "risk-r-multiple"],
  },
];

const FINANCIAL_WIKI_LOG = [
  { date: "2026-06-03", event: "重构金融知识模块为 Wiki 结构，补齐 purpose、schema、index、pages 与 lint 清单。" },
  { date: "2026-05-30", event: "接入因子目录与基础组件视图，知识页面开始引用本地 market-data 字段口径。" },
  { date: "2026-05-28", event: "策略平台新增股票池、策略目录、参数扫描和回测归档入口。" },
] as const;

const FINANCIAL_WIKI_ENTRY_POINTS = [
  {
    id: "strategy-context",
    title: "策略生成上下文",
    description: "把数据契约、复权口径和样本完整性作为生成前置条件。",
    pageIds: ["market-data-contract", "adjustment-calendar", "backtest-integrity"],
  },
  {
    id: "trade-price",
    title: "买卖价格判断",
    description: "用开盘强弱、ATR 和收益风险比约束追高、止损和目标价。",
    pageIds: ["gap-open-support", "atr-volatility", "risk-r-multiple"],
  },
  {
    id: "factor-research",
    title: "因子口径校验",
    description: "确认均线、资金流、成交额和流动性字段是否可用于排序。",
    pageIds: ["moving-average", "dde-order-flow", "turnover-liquidity"],
  },
  {
    id: "risk-review",
    title: "回测与风控复核",
    description: "检查涨跌停、流动性、回撤和缺失字段是否影响结果可信度。",
    pageIds: ["limit-up-down", "turnover-liquidity", "risk-r-multiple"],
  },
] as const;

function pageTypeClass(type: FinancialWikiPageType) {
  if (type === "indicator") return "border-blue-200 bg-blue-50 text-blue-700";
  if (type === "workflow") return "border-violet-200 bg-violet-50 text-violet-700";
  if (type === "risk") return "border-red-200 bg-red-50 text-red-700";
  if (type === "source") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function parseWikiLinkTitle(link: string) {
  return link.replace(/^\[\[/, "").replace(/\]\]$/, "");
}

function FinancialKnowledgeView() {
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<FinancialWikiPageType | "all">("all");
  const [selectedPageId, setSelectedPageId] = useState<string>(FINANCIAL_WIKI_PAGES[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const pageById = useMemo(() => new Map(FINANCIAL_WIKI_PAGES.map((page) => [page.id, page])), []);
  const pageByTitle = useMemo(() => new Map(FINANCIAL_WIKI_PAGES.map((page) => [page.title, page])), []);
  const selectedCollection = FINANCIAL_WIKI_COLLECTIONS.find((collection) => collection.id === selectedCollectionId);
  const selectedCollectionPages = useMemo(
    () => (selectedCollection ? new Set(selectedCollection.pages) : null),
    [selectedCollection],
  );
  const filteredPages = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return FINANCIAL_WIKI_PAGES.filter((page) => {
      const collectionMatch = !selectedCollectionPages || selectedCollectionPages.has(page.id);
      const typeMatch = selectedType === "all" || page.type === selectedType;
      const text = [
        page.id,
        page.title,
        page.type,
        page.domain,
        page.summary,
        page.formula,
        page.decisionUse,
        page.qualityGate,
        ...page.sources,
        ...page.links,
        ...page.caveats,
      ].join(" ").toLowerCase();
      return collectionMatch && typeMatch && (!lower || text.includes(lower));
    });
  }, [query, selectedCollectionPages, selectedType]);

  useEffect(() => {
    if (filteredPages.length && !filteredPages.some((page) => page.id === selectedPageId)) {
      setSelectedPageId(filteredPages[0].id);
    }
  }, [filteredPages, selectedPageId]);

  const pageTypes = Object.keys(FINANCIAL_WIKI_PAGE_TYPE_LABELS) as FinancialWikiPageType[];
  const linkGraphEdges = FINANCIAL_WIKI_PAGES.reduce((sum, page) => sum + page.links.length, 0);
  const sourceCount = new Set(FINANCIAL_WIKI_PAGES.flatMap((page) => page.sources)).size;
  const selectedPage = pageById.get(selectedPageId) ?? filteredPages[0] ?? FINANCIAL_WIKI_PAGES[0];
  const relatedPages = selectedPage
    ? selectedPage.links
        .map((link) => pageByTitle.get(parseWikiLinkTitle(link)))
        .filter((page): page is FinancialWikiPage => Boolean(page))
    : [];
  const selectedCollectionName = selectedCollection?.name ?? "全部页面";

  if (!selectedPage) {
    return <EmptyState title="知识库暂无页面" description="补充页面后会出现在这里" className="border-0" />;
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <BookOpen className="h-5 w-5 text-blue-500" />
              <h2 className="text-lg font-semibold text-slate-950">{FINANCIAL_WIKI_PURPOSE.title}</h2>
              <Badge variant="outline" className="bg-white text-slate-500">LLM Wiki</Badge>
            </div>
            <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-600">{FINANCIAL_WIKI_PURPOSE.statement}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-right">
            {[
              { label: "页面", value: FINANCIAL_WIKI_PAGES.length },
              { label: "来源", value: sourceCount },
              { label: "链接", value: linkGraphEdges },
            ].map((item) => (
              <div key={item.label} className="min-w-[74px] rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] text-slate-500">{item.label}</p>
                <p className="mt-0.5 text-lg font-bold tabular-nums text-slate-950">{item.value}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-4 px-5 py-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.1fr)]">
          <div className="relative h-11 self-start">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索：均线、ATR、资金流、回测、数据源..."
              className="h-11 border-slate-200 bg-white pl-10 text-sm"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {FINANCIAL_WIKI_ENTRY_POINTS.map((entry) => {
              const firstPage = pageById.get(entry.pageIds[0]);
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setSelectedCollectionId("all");
                    setSelectedType("all");
                    setQuery("");
                    if (firstPage) setSelectedPageId(firstPage.id);
                  }}
                  className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left transition-colors hover:border-blue-200 hover:bg-blue-50"
                >
                  <p className="truncate text-sm font-semibold text-slate-900">{entry.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{entry.description}</p>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[280px_minmax(360px,0.92fr)_minmax(420px,1.08fr)]">
        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-semibold text-slate-950">index.md</p>
              <p className="mt-1 text-xs text-slate-500">{selectedCollectionName}</p>
            </div>
            <div className="space-y-2 p-3">
              <button
                type="button"
                onClick={() => setSelectedCollectionId("all")}
                className={cn(
                  "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  selectedCollectionId === "all"
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                )}
              >
                <span className="font-medium">全部页面</span>
                <span className="tabular-nums text-slate-400">{FINANCIAL_WIKI_PAGES.length}</span>
              </button>
              {FINANCIAL_WIKI_COLLECTIONS.map((collection) => (
                <button
                  key={collection.id}
                  type="button"
                  onClick={() => setSelectedCollectionId(collection.id)}
                  className={cn(
                    "w-full rounded-md border px-3 py-2 text-left transition-colors",
                    selectedCollectionId === collection.id
                      ? "border-blue-200 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  )}
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{collection.name}</span>
                    <span className="tabular-nums text-slate-400">{collection.pages.length}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{collection.description}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-slate-950">页面类型</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelectedType("all")}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                  selectedType === "all" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-600"
                )}
              >
                全部
              </button>
              {pageTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSelectedType(type)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    selectedType === type ? pageTypeClass(type) : "border-slate-200 bg-white text-slate-600"
                  )}
                >
                  {FINANCIAL_WIKI_PAGE_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <DatabaseZap className="h-4 w-4 text-emerald-500" />
              <p className="text-sm font-semibold text-slate-950">sources</p>
            </div>
            <div className="mt-3 space-y-2 text-xs leading-5 text-slate-600">
              {FINANCIAL_WIKI_PURPOSE.scope.map((item) => (
                <p key={item}>{item}</p>
              ))}
            </div>
          </div>
        </aside>

        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-950">pages/</p>
              <p className="mt-1 text-xs text-slate-500">
                {filteredPages.length} / {FINANCIAL_WIKI_PAGES.length} 页 · {selectedCollectionName}
              </p>
            </div>
            <Badge variant="outline" className="bg-white text-slate-500">
              {selectedType === "all" ? "全部类型" : FINANCIAL_WIKI_PAGE_TYPE_LABELS[selectedType]}
            </Badge>
          </div>

          <div className="max-h-[calc(100vh-280px)] overflow-y-auto p-3">
            <div className="space-y-2">
              {filteredPages.map((page) => {
                const active = selectedPage.id === page.id;
                return (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => setSelectedPageId(page.id)}
                    className={cn(
                      "w-full rounded-lg border p-4 text-left transition-colors",
                      active
                        ? "border-blue-300 bg-blue-50 shadow-sm shadow-blue-100"
                        : "border-slate-200 bg-white hover:border-blue-200 hover:bg-slate-50"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className={pageTypeClass(page.type)}>
                            {FINANCIAL_WIKI_PAGE_TYPE_LABELS[page.type]}
                          </Badge>
                          <span className="text-xs text-slate-400">{page.domain}</span>
                        </div>
                        <h3 className="mt-2 truncate text-base font-bold text-slate-950">{page.title}</h3>
                      </div>
                      <ArrowRight className={cn("mt-1 h-4 w-4 shrink-0", active ? "text-blue-500" : "text-slate-300")} />
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">{page.summary}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                      <span className="rounded bg-slate-100 px-2 py-1 text-slate-500">{page.sources.length} sources</span>
                      <span className="rounded bg-slate-100 px-2 py-1 text-slate-500">{page.links.length} wikilinks</span>
                      <span className="rounded bg-slate-100 px-2 py-1 text-slate-500">status: maintained</span>
                    </div>
                  </button>
                );
              })}

              {!filteredPages.length && (
                <EmptyState title="没有匹配的知识页面" description="调整目录、类型或搜索关键词" className="border-0" />
              )}
            </div>
          </div>
        </div>

        <article className="rounded-lg border border-slate-200 bg-white shadow-sm xl:sticky xl:top-24 xl:self-start">
          <div className="border-b border-slate-100 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={pageTypeClass(selectedPage.type)}>
                {FINANCIAL_WIKI_PAGE_TYPE_LABELS[selectedPage.type]}
              </Badge>
              <Badge variant="outline" className="bg-white text-slate-500">{selectedPage.domain}</Badge>
              <code className="rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-500">
                {selectedPage.id}.md
              </code>
            </div>
            <h3 className="mt-3 text-xl font-bold text-slate-950">{selectedPage.title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{selectedPage.summary}</p>
          </div>

          <div className="max-h-[calc(100vh-260px)] overflow-y-auto p-5">
            <div className="grid gap-3">
              {selectedPage.formula && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">formula</p>
                  <code className="mt-2 block whitespace-pre-wrap font-mono text-xs leading-6 text-slate-800">
                    {selectedPage.formula}
                  </code>
                </div>
              )}

              <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-500">decision use</p>
                <p className="mt-2 text-sm leading-6 text-blue-950">{selectedPage.decisionUse}</p>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">quality gate</p>
                  <p className="mt-2 text-sm leading-6 text-emerald-950">{selectedPage.qualityGate}</p>
                </div>
                <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">caveats</p>
                  <div className="mt-2 space-y-1 text-sm leading-6 text-amber-950">
                    {selectedPage.caveats.map((caveat) => <p key={`${selectedPage.id}-caveat-${caveat}`}>{caveat}</p>)}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">sources</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedPage.sources.map((source) => (
                    <code key={`${selectedPage.id}-source-${source}`} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-600">
                      {source}
                    </code>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-blue-500" />
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">wikilinks</p>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {relatedPages.map((page) => (
                    <button
                      key={`${selectedPage.id}-related-${page.id}`}
                      type="button"
                      onClick={() => {
                        setSelectedCollectionId("all");
                        setSelectedType("all");
                        setQuery("");
                        setSelectedPageId(page.id);
                      }}
                      className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left transition-colors hover:border-blue-200 hover:bg-blue-50"
                    >
                      <p className="truncate text-sm font-semibold text-slate-900">{page.title}</p>
                      <p className="mt-1 text-xs text-slate-500">{FINANCIAL_WIKI_PAGE_TYPE_LABELS[page.type]} · {page.domain}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">agent context</p>
                <div className="mt-3 rounded-md border border-slate-200 bg-white p-3 font-mono text-[11px] leading-5 text-slate-600">
                  <p>page: {selectedPage.title}</p>
                  <p>type: {selectedPage.type}</p>
                  <p>qualityGate: {selectedPage.qualityGate}</p>
                  <p>sources: {selectedPage.sources.join(", ")}</p>
                </div>
              </div>
            </div>
          </div>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Ingest / Query / Lint</h3>
              <p className="mt-1 text-sm text-slate-500">知识页面按摄入、查询和检查的固定生命周期维护。</p>
            </div>
            <Badge variant="outline" className="bg-white text-slate-500">protocol</Badge>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {FINANCIAL_WIKI_OPERATIONS.map((operation) => (
              <article key={operation.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-bold text-slate-950">{operation.title}</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">{operation.description}</p>
                <div className="mt-3 space-y-1">
                  {operation.checks.map((check) => (
                    <p key={`${operation.id}-${check}`} className="flex gap-2 text-xs leading-5 text-slate-600">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      <span>{check}</span>
                    </p>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-950">log.md</p>
          <div className="mt-3 space-y-3">
            {FINANCIAL_WIKI_LOG.map((item) => (
              <div key={`${item.date}-${item.event}`} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="font-mono text-xs font-semibold text-slate-500">{item.date}</p>
                <p className="mt-1 text-sm leading-6 text-slate-700">{item.event}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function foundationStatusLabel(status: StrategyFoundationComponent["status"]) {
  if (status === "ready") return "已就绪";
  if (status === "missing") return "缺失";
  return "部分就绪";
}

function foundationStatusClass(status: StrategyFoundationComponent["status"]) {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "missing") return "border-red-200 bg-red-50 text-red-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function factorStatusClass(status: string) {
  if (status === "active") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "planned") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function factorCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    technical: "技术指标",
    liquidity: "流动性",
    event: "事件",
    capital_flow: "资金流",
    valuation: "估值",
    momentum: "动量",
    risk: "风险",
    quality: "质量",
    growth: "成长",
  };
  return labels[category] ?? category;
}

function FoundationView({
  data,
  onRefresh,
}: {
  data: StrategyDashboardData;
  onRefresh: () => Promise<void>;
}) {
  const [isScanning, setIsScanning] = useState(false);
  const [scan, setScan] = useState(data.foundation.latestQualityScan ?? null);
  const [error, setError] = useState<string | null>(null);
  const factorGroups = useMemo(() => {
    const groups = new Map<string, StrategyFactorDefinition[]>();
    for (const factor of data.foundation.factors) {
      const list = groups.get(factor.category) ?? [];
      list.push(factor);
      groups.set(factor.category, list);
    }
    return Array.from(groups.entries());
  }, [data.foundation.factors]);
  const lastOpenDay = data.foundation.calendarDays.filter((item) => item.isOpen).at(-1);

  const runScan = async () => {
    setIsScanning(true);
    setError(null);
    try {
      const universeId = data.research.primaryUniverseId;
      const response = await fetch(`${API_BASE}/api/quant/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "data-quality-scan",
          universeId,
          lookbackYears: data.research.ingestionPlan.lookbackYears,
          timeframe: data.research.ingestionPlan.timeframe,
          adjustment: data.research.ingestionPlan.adjustment,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error ?? "数据质量扫描失败");
      setScan(payload.data);
      await onRefresh();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="space-y-4">
      {data.foundation.error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {data.foundation.error}
        </div>
      )}

      <section className="grid gap-3 lg:grid-cols-5">
        {data.foundation.components.map((component) => (
          <div key={component.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-950">{component.name}</p>
                <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{component.count.toLocaleString()}</p>
              </div>
              <Badge variant="outline" className={foundationStatusClass(component.status)}>
                {foundationStatusLabel(component.status)}
              </Badge>
            </div>
            <p className="mt-3 min-h-10 text-xs leading-5 text-slate-500">{component.detail ?? "-"}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(420px,0.9fr)]">
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">数据质量扫描</h3>
              <p className="mt-1 text-xs text-slate-500">检查缺 K、最新交易日、成交额、换手率、停牌/ST 和涨跌停字段。</p>
            </div>
            <Button size="sm" onClick={runScan} disabled={isScanning}>
              {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              运行扫描
            </Button>
          </div>
          {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
          {scan ? (
            <div className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-5">
                {[
                  { label: "检查标的", value: scan.checkedSymbols },
                  { label: "通过", value: scan.passedSymbols },
                  { label: "警告", value: scan.warningSymbols },
                  { label: "失败", value: scan.failedSymbols },
                  { label: "问题", value: scan.issueCount },
                ].map((item) => (
                  <div key={item.label} className="rounded-md bg-slate-50 px-3 py-2">
                    <p className="text-xs text-slate-500">{item.label}</p>
                    <p className="mt-1 text-lg font-bold tabular-nums text-slate-950">{item.value.toLocaleString()}</p>
                  </div>
                ))}
              </div>
              <div className="overflow-hidden rounded-md border border-slate-200">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">标的</th>
                      <th className="px-3 py-2 font-medium">级别</th>
                      <th className="px-3 py-2 font-medium">类型</th>
                      <th className="px-3 py-2 font-medium">说明</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {scan.issues.slice(0, 12).map((issue, index) => (
                      <tr key={`${issue.symbol ?? "market"}-${issue.issueType}-${index}`}>
                        <td className="px-3 py-2 font-mono text-xs text-slate-700">
                          {issue.name ? `${issue.name} ` : ""}{issue.symbol ?? "-"}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={
                            issue.severity === "error"
                              ? "border-red-200 bg-red-50 text-red-700"
                              : issue.severity === "warning"
                                ? "border-amber-200 bg-amber-50 text-amber-700"
                                : "border-emerald-200 bg-emerald-50 text-emerald-700"
                          }>
                            {issue.severity}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-slate-600">{issue.issueType}</td>
                        <td className="px-3 py-2 text-slate-600">{issue.message}</td>
                      </tr>
                    ))}
                    {!scan.issues.length && (
                      <tr>
                        <td className="px-3 py-6 text-center text-slate-500" colSpan={4}>
                          当前扫描未发现关键问题
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState title="尚未运行数据质量扫描" description="运行一次扫描后会归档到后端数据质量组件" className="border-0" />
          )}
        </div>

        <div className="space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">交易日历</h3>
                <p className="mt-1 text-xs text-slate-500">
                  {lastOpenDay ? `最新开市日 ${lastOpenDay.tradeDate}` : "暂无独立交易日历，回退到 K 线日期推断"}
                </p>
              </div>
              <Badge variant="outline" className="bg-white text-slate-500">
                {data.foundation.calendarDays.length} 日
              </Badge>
            </div>
            <div className="mt-4 grid grid-cols-5 gap-2">
              {data.foundation.calendarDays.slice(-15).map((day) => (
                <div key={`${day.market}-${day.tradeDate}`} className={cn(
                  "rounded-md border px-2 py-2 text-center text-xs",
                  day.isOpen ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-400"
                )}>
                  <p className="font-mono">{day.tradeDate.slice(5)}</p>
                  <p className="mt-1">{day.source === "stock_bars-inferred" ? "推断" : day.isOpen ? "开市" : "休市"}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-950">因子定义仓库</h3>
              <p className="mt-1 text-xs text-slate-500">策略目录和首页对话优先读取这些口径说明。</p>
            </div>
            <div className="max-h-[520px] overflow-y-auto p-4">
              {factorGroups.length ? (
                <div className="space-y-4">
                  {factorGroups.map(([category, factors]) => (
                    <div key={category}>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold text-slate-500">{factorCategoryLabel(category)}</p>
                        <span className="text-xs tabular-nums text-slate-400">{factors.length}</span>
                      </div>
                      <div className="space-y-2">
                        {factors.map((factor) => (
                          <div key={factor.factorKey} className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-semibold text-slate-900">{factor.name}</p>
                              <Badge variant="outline" className={factorStatusClass(factor.status)}>
                                {factor.status}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs leading-5 text-slate-500">{factor.description}</p>
                            {factor.formula && (
                              <code className="mt-2 block rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-600">
                                {factor.formula}
                              </code>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="暂无因子定义" description="执行 db:init 后会登记核心因子口径" className="border-0" />
              )}
            </div>
          </section>
        </div>
      </section>
    </div>
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
    <div className="min-h-screen bg-surface text-slate-900">
      <PageHeader
        title="策略平台"
        badge={<Badge variant="outline" className="bg-white text-slate-500">{data.summary.templates} 个策略模板</Badge>}
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

      <main className="mx-auto w-full max-w-[1900px] space-y-5 px-3 py-6 lg:px-4">
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
