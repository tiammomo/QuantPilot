import type { SubNavItem } from "@/components/layout/SubNav";
import { BarChart3, BookOpen, DatabaseZap, GitBranch, SquareStack, TrendingUp } from "lucide-react";
import type {
  StrategyCatalogItem,
  StrategyIngestionJob,
  StrategyUniverse,
  StrategyUniverseMember,
} from '@/lib/quant/strategy-types';

export type StrategyView =
  | "universe"
  | "catalog"
  | "factors"
  | "sectorFlow"
  | "foundation"
  | "knowledge"
  | "scans"
  | "compare";
export type IngestionRangeMode = "incremental" | "lookback" | "custom";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
export const INGESTION_BATCH_SIZE = 25;
export const INGESTION_LOG_LIMIT = 20;
export const INGESTION_STALE_HEARTBEAT_MS = 15 * 60 * 1000;
export const INGESTION_STOP_GRACE_MS = 60 * 1000;

// ─── Status helpers ────────────────────────────────────────────
export function statusLabel(s: StrategyCatalogItem["status"]) {
  return s === "ready" ? "可执行" : s === "research" ? "需补数据" : "规划中";
}
export function statusClass(s: StrategyCatalogItem["status"]) {
  if (s === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (s === "research") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}
export function scanStatusClass(s: StrategyCatalogItem["parameterScans"][number]["status"]) {
  if (s === "available") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (s === "planned") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-red-200 bg-red-50 text-red-700";
}
export function scanStatusLabel(s: StrategyCatalogItem["parameterScans"][number]["status"]) {
  if (s === "available") return "可执行";
  if (s === "planned") return "规划中";
  return "阻断";
}
export function riskClass(level: StrategyCatalogItem["readiness"]["riskLevel"]) {
  if (level === "low") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (level === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-red-200 bg-red-50 text-red-700";
}
export function strategyKindLabel(kind?: StrategyCatalogItem["kind"]) {
  if (kind === "stock_selection") return "选股";
  if (kind === "trade_price") return "买卖价格";
  return "策略";
}
export function strategyKindClass(kind?: StrategyCatalogItem["kind"]) {
  if (kind === "stock_selection") return "border-blue-200 bg-blue-50 text-blue-700";
  if (kind === "trade_price") return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}
export function ruleStatusClass(status?: "ready" | "needs_data" | "manual") {
  if (status === "needs_data") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "manual") return "border-slate-200 bg-slate-50 text-slate-600";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}
export function ruleStatusLabel(status?: "ready" | "needs_data" | "manual") {
  if (status === "needs_data") return "缺数据";
  if (status === "manual") return "人工确认";
  return "已具备";
}
export function previewRules(strategy: StrategyCatalogItem) {
  const rules = strategy.kind === "trade_price"
    ? [...(strategy.entryRules ?? []), ...(strategy.exitRules ?? [])]
    : strategy.selectionRules ?? [];
  return rules.slice(0, 3);
}
export function dataStatusText(strategy: StrategyCatalogItem) {
  const missing = strategy.dataReadiness?.missing.length ?? 0;
  if (missing > 0) return `缺 ${missing} 项`;
  return "数据可用";
}
export function formatMetric(value?: number | null, suffix = "") {
  if (value === null || value === undefined) return "-";
  return `${Number(value).toFixed(2)}${suffix}`;
}

export function formatDataDate(value?: string | null) {
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

export function formatDateTime(value?: string | null) {
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

export function formatIntradayTime(value?: string | null) {
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

export function todayInputValue() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDaysInputValue(value: string, days: number) {
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

export function formatDuration(seconds?: number | null) {
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

export function timestampMs(value?: string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export function finiteNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatNumberValue(value?: number | null, digits = 2) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatSignedNumberValue(value?: number | null, digits = 2) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return `${number >= 0 ? "+" : ""}${formatNumberValue(number, digits)}`;
}

export function formatLargeValue(value?: number | null, digits = 2) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  const abs = Math.abs(number);
  if (abs >= 100000000) return `${formatNumberValue(number / 100000000, digits)} 亿`;
  if (abs >= 10000) return `${formatNumberValue(number / 10000, digits)} 万`;
  return formatNumberValue(number, digits);
}

export function formatSignedPercent(value?: number | null) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

export function formatPercentValue(value?: number | null) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return `${number.toFixed(2)}%`;
}

export function signedToneClass(value?: number | null) {
  const number = finiteNumber(value);
  if (number === null) return "text-slate-900";
  return number >= 0 ? "text-red-600" : "text-emerald-600";
}

export function trendLabel(status: StrategyUniverseMember["trendStatus"]) {
  if (status === "bullish") return "多头";
  if (status === "bearish") return "空头";
  if (status === "sideways") return "震荡";
  return "不足";
}

export function trendClass(status: StrategyUniverseMember["trendStatus"]) {
  if (status === "bullish") return "border-red-200 bg-red-50 text-red-700";
  if (status === "bearish") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "sideways") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-500";
}

export function liquidityLabel(member: StrategyUniverseMember) {
  if (finiteNumber(member.avgAmount20d) !== null) return formatLargeValue(member.avgAmount20d, 1);
  if (finiteNumber(member.avgVolume20d) !== null) return formatLargeValue(member.avgVolume20d, 1);
  return "-";
}

export function liquiditySubLabel(member: StrategyUniverseMember) {
  if (finiteNumber(member.avgAmount20d) !== null && finiteNumber(member.avgTurnover20d) !== null) {
    return `20日均额 · 换手 ${formatPercentValue(member.avgTurnover20d)}`;
  }
  if (finiteNumber(member.avgAmount20d) !== null) return "20日均额";
  if (finiteNumber(member.avgTurnover20d) !== null) return `20日换手 ${formatPercentValue(member.avgTurnover20d)}`;
  if (finiteNumber(member.avgVolume20d) !== null) return "20日均量";
  return "暂无";
}

export function valuationSummary(member: StrategyUniverseMember) {
  const pe = finiteNumber(member.peTtm);
  const pb = finiteNumber(member.pbMrq);
  if (pe === null && pb === null) return "-";
  return [
    pe !== null ? `PE ${formatNumberValue(pe, 1)}` : null,
    pb !== null ? `PB ${formatNumberValue(pb, 1)}` : null,
  ].filter(Boolean).join(" / ");
}

export function tradeStatusLabel(member: StrategyUniverseMember) {
  if (member.limitUp) return "涨停";
  if (member.limitDown) return "跌停";
  if (member.tradeStatus && member.tradeStatus !== "1") return "停牌";
  if (member.isSt) return "ST";
  return "正常";
}

export function tradeStatusClass(member: StrategyUniverseMember) {
  if (member.limitUp) return "border-red-200 bg-red-50 text-red-700";
  if (member.limitDown) return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (member.tradeStatus && member.tradeStatus !== "1") return "border-amber-200 bg-amber-50 text-amber-700";
  if (member.isSt) return "border-orange-200 bg-orange-50 text-orange-700";
  return "border-slate-200 bg-slate-50 text-slate-500";
}

export function isEtfUniverse(universe?: StrategyUniverse | null) {
  if (!universe) return false;
  return universe.id === "etf-index-pool" || universe.etfCount + universe.indexCount > universe.stockCount;
}

export function jobStatusLabel(status: string) {
  if (status === "completed") return "已完成";
  if (status === "partial") return "部分完成";
  if (status === "failed") return "失败";
  if (status === "running") return "运行中";
  if (status === "queued") return "排队中";
  return status || "-";
}

export function jobStatusClass(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  return "border-blue-200 bg-blue-50 text-blue-700";
}

export function ingestionControlLabel(control?: string | null) {
  if (control === "pause") return "暂停中";
  if (control === "stop") return "停止中";
  if (control === "resume" || control === "run") return "运行";
  if (control === "idle") return "空闲";
  return "-";
}

export function ingestionRangeLabel(job?: StrategyIngestionJob | null) {
  if (!job) return "-";
  const start = stringFromUnknown(job.metadata.effective_start) ?? stringFromUnknown(job.metadata.start);
  const end = stringFromUnknown(job.metadata.end);
  if (!start && (!end || end === "20500101")) return "近 5 年";
  return `${start ?? "默认"} 至 ${end && end !== "20500101" ? end : "最新交易日"}`;
}

export function findLatestUniverseBatchJob(jobs: StrategyIngestionJob[]) {
  return jobs.find((job) => job.provider !== "baostock-autofill" && (job.universeTotalSymbols ?? 0) > 1) ?? null;
}

export function findLatestAutoFillJob(jobs: StrategyIngestionJob[]) {
  return jobs.find((job) => job.provider === "baostock-autofill") ?? null;
}

export function findLatestRunningAutoFillChildJob(jobs: StrategyIngestionJob[]) {
  return jobs.find((job) => job.status === "running" && !isStaleRunningIngestionJob(job) && stringFromUnknown(job.metadata.parent_job_id)) ?? null;
}

export function ingestionControlJobId(job?: StrategyIngestionJob | null) {
  if (!job) return null;
  return job.provider === "baostock-autofill"
    ? job.id
    : stringFromUnknown(job.metadata.parent_job_id) ?? job.id;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type IngestionSymbolLog = {
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

export function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringFromUnknown(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

export function isStaleRunningIngestionJob(job: StrategyIngestionJob | null | undefined) {
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

export function completedJobDurationSeconds(job: StrategyIngestionJob) {
  const startedAt = timestampMs(job.startedAt ?? job.createdAt);
  const endedAt = timestampMs(job.completedAt ?? job.updatedAt);
  if (!startedAt || !endedAt || endedAt <= startedAt) return null;
  return Math.max(1, (endedAt - startedAt) / 1000);
}

export function recentIngestionSymbolRate(job: StrategyIngestionJob, jobs: StrategyIngestionJob[]) {
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

export function ingestionProgress(job: StrategyIngestionJob | null | undefined, jobs: StrategyIngestionJob[] = []) {
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

export function getIngestionSymbolLogs(job: StrategyIngestionJob): IngestionSymbolLog[] {
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

export function ingestionBatchRangeLabel(job: StrategyIngestionJob) {
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

export function ingestionSymbolPreview(job: StrategyIngestionJob) {
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

export function ingestionErrorPreview(job: StrategyIngestionJob) {
  if (job.error) return job.error;
  const failed = getIngestionSymbolLogs(job).filter((item) => item.error);
  if (!failed.length) return null;
  return failed
    .slice(0, 3)
    .map((item) => `${item.symbol}: ${item.error}`)
    .join("；");
}

// ─── Sub-nav items ─────────────────────────────────────────────
export const SUB_NAV_ITEMS: SubNavItem[] = [
  { id: "universe", label: "股票池", icon: <SquareStack className="h-4 w-4" /> },
  { id: "catalog", label: "策略目录", icon: <TrendingUp className="h-4 w-4" /> },
  { id: "factors", label: "因子目录", icon: <GitBranch className="h-4 w-4" /> },
  { id: "sectorFlow", label: "板块资金", icon: <BarChart3 className="h-4 w-4" /> },
  { id: "foundation", label: "基础组件", icon: <DatabaseZap className="h-4 w-4" /> },
  { id: "knowledge", label: "金融知识", icon: <BookOpen className="h-4 w-4" /> },
];

// ─── Strategy Selector Bar ─────────────────────────────────────
