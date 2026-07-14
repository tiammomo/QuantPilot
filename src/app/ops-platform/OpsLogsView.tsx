"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Clock3,
  ExternalLink,
  FileClock,
  Search,
  ScrollText,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { formatCompactDate as formatDate } from "@/components/quant/console-primitives";
import { cn } from "@/lib/utils";
import type { OpsLogEntry, OpsPlatformDashboard } from "@/lib/ops/ops-platform";
import { formatBytes, OpsMetricCard, OpsSectionHeader, OpsStatusBadge } from "./OpsConsolePrimitives";

type TimeRange = "all" | "5m" | "30m" | "1h" | "6h" | "24h";
type LevelFilter = "all" | "error" | "warning" | "info";
const LOG_RENDER_BATCH = 300;

const TIME_RANGES: Array<{ id: TimeRange; label: string; minutes: number | null }> = [
  { id: "all", label: "全部", minutes: null },
  { id: "5m", label: "5 分钟", minutes: 5 },
  { id: "30m", label: "30 分钟", minutes: 30 },
  { id: "1h", label: "1 小时", minutes: 60 },
  { id: "6h", label: "6 小时", minutes: 360 },
  { id: "24h", label: "24 小时", minutes: 1440 },
];

function normalizeEntries(source: OpsPlatformDashboard["logSources"][number] | null): OpsLogEntry[] {
  if (!source) return [];
  if (source.entries?.length) return source.entries;
  return source.lines.map((line, index) => ({
    id: `${source.id}-${index}`,
    lineNumber: index + 1,
    timestamp: source.modifiedAt,
    timestampSource: source.modifiedAt ? "source-modified" : null,
    level: null,
    message: line,
    raw: line,
  }));
}

function normalizeLevel(level: string | null) {
  const value = level?.toUpperCase() ?? "";
  if (["ERROR", "FATAL"].includes(value)) return "error";
  if (["WARN", "WARNING"].includes(value)) return "warning";
  if (["INFO", "LOG"].includes(value)) return "info";
  return "other";
}

function logLevelClass(level: string | null) {
  const normalized = normalizeLevel(level);
  if (normalized === "error") return "text-red-300";
  if (normalized === "warning") return "text-amber-300";
  if (normalized === "info") return "text-sky-300";
  return "text-slate-500";
}

function formatLogTimestamp(value: string | null) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function OpsLogsView({ data }: { data: OpsPlatformDashboard }) {
  const firstAvailable = data.logSources.find((source) => source.exists) ?? data.logSources[0] ?? null;
  const [activeId, setActiveId] = useState<string | null>(firstAvailable?.id ?? null);
  const [keyword, setKeyword] = useState("");
  const [range, setRange] = useState<TimeRange>("all");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [renderLimit, setRenderLimit] = useState(LOG_RENDER_BATCH);
  const active = data.logSources.find((source) => source.id === activeId) ?? firstAvailable;
  const entries = useMemo(() => normalizeEntries(active), [active]);
  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    const rangeConfig = TIME_RANGES.find((item) => item.id === range);
    const threshold = rangeConfig?.minutes ? Date.now() - rangeConfig.minutes * 60_000 : null;
    return entries.filter((entry) => {
      if (level !== "all" && normalizeLevel(entry.level) !== level) return false;
      if (threshold) {
        const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
        if (!Number.isFinite(timestamp) || timestamp < threshold) return false;
      }
      if (!lower) return true;
      return [entry.raw, entry.message, entry.level, entry.lineNumber, entry.timestamp].filter(Boolean).join(" ").toLowerCase().includes(lower);
    });
  }, [entries, keyword, level, range]);
  const readableSources = data.logSources.filter((source) => source.exists);
  const visibleEntries = useMemo(
    () => filtered.slice(Math.max(0, filtered.length - renderLimit)),
    [filtered, renderLimit],
  );
  const hiddenEntryCount = Math.max(0, filtered.length - visibleEntries.length);
  const totalLines = readableSources.reduce((sum, source) => sum + source.lineCount, 0);
  const errorCount = entries.filter((entry) => normalizeLevel(entry.level) === "error").length;
  const approximateCount = filtered.filter((entry) => entry.timestampSource === "source-modified").length;

  useEffect(() => {
    setRenderLimit(LOG_RENDER_BATCH);
  }, [activeId, keyword, level, range]);

  return (
    <div className="space-y-7">
      <OpsSectionHeader eyebrow="RUNTIME LOGS" title="运行日志与故障现场" description="优先查询 Loki 集中日志；可观测组件不可用时自动降级到本地文件，并明确标注时间精度。" />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OpsMetricCard icon={<ScrollText className="h-4 w-4" />} label="可读日志源" value={`${readableSources.length}/${data.logSources.length}`} helper="集中日志与本地文件统一入口" tone={readableSources.length ? "emerald" : "red"} />
        <OpsMetricCard icon={<TerminalSquare className="h-4 w-4" />} label="已加载行数" value={totalLines.toLocaleString("zh-CN")} helper="当前聚合数据范围" tone="blue" />
        <OpsMetricCard icon={<FileClock className="h-4 w-4" />} label="当前日志" value={active?.lineCount ?? 0} helper={active ? `${active.label} · ${formatDate(active.modifiedAt)}` : "没有日志源"} tone="primary" />
        <OpsMetricCard icon={<Clock3 className="h-4 w-4" />} label="当前错误" value={errorCount} helper="按结构化日志级别识别" tone={errorCount ? "red" : "emerald"} />
      </section>

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <section className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)]">
          <div className="border-b border-border/50 px-4 py-4"><h3 className="text-sm font-bold text-foreground">日志源</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">选择需要排查的运行组件</p></div>
          <div className="flex snap-x gap-2 overflow-x-auto p-3 xl:block xl:space-y-1 xl:overflow-visible xl:p-2">
            {data.logSources.map((source) => (
              <button key={source.id} type="button" onClick={() => setActiveId(source.id)} className={cn("min-w-[235px] snap-start rounded-lg border px-3 py-3 text-left transition-colors xl:min-w-0 xl:w-full", active?.id === source.id ? "border-primary/25 bg-primary/10" : "border-transparent hover:border-border hover:bg-muted/40")}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-foreground">{source.label}</span><OpsStatusBadge status={source.exists ? "ok" : "warning"} label={source.exists ? "可读" : "不可用"} /></div>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{source.path}</p>
                <p className="mt-2 text-[11px] text-muted-foreground">{source.exists ? `${source.lineCount} 行 · ${source.type === "loki" ? "集中日志" : formatBytes(source.sizeBytes)}` : source.error ?? "尚未生成"}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)]">
          <div className="flex flex-col gap-3 border-b border-border/50 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0"><h3 className="text-sm font-bold text-foreground">{active?.label ?? "暂无日志"}</h3><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{active?.path ?? "-"}</p></div>
            <div className="flex items-center gap-2">{active && <OpsStatusBadge status={active.exists ? "ok" : "warning"} />}{active?.externalUrl && <Button variant="outline" size="sm" asChild><a href={active.externalUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Grafana</a></Button>}</div>
          </div>
          <div className="space-y-3 border-b border-border/50 px-4 py-4">
            <div className="flex flex-col gap-3 lg:flex-row">
              <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索内容、级别、时间或行号" className="h-10 bg-background pl-9" aria-label="搜索日志" /></div>
              <div className="flex flex-wrap gap-1.5">{(["all", "error", "warning", "info"] as LevelFilter[]).map((item) => { const labels: Record<LevelFilter, string> = { all: "全部级别", error: "错误", warning: "警告", info: "信息" }; return <button key={item} type="button" onClick={() => setLevel(item)} className={cn("rounded-lg border px-3 py-2 text-xs font-semibold", level === item ? "border-primary/30 bg-primary/10 text-primary" : "border-border/60 bg-background text-muted-foreground")}>{labels[item]}</button>; })}</div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">{TIME_RANGES.map((item) => <button key={item.id} type="button" onClick={() => setRange(item.id)} className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", range === item.id ? "border-primary/30 bg-primary/10 text-primary" : "border-border/60 bg-background text-muted-foreground")}>{item.label}</button>)}<span className="ml-auto text-xs text-muted-foreground">匹配 {filtered.length}/{entries.length} 行 · 已渲染 {visibleEntries.length}</span></div>
            {approximateCount > 0 && range !== "all" && <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">{approximateCount} 行缺少原始时间，已按文件更新时间近似筛选。</p>}
          </div>
          {active?.exists && entries.length ? (
            filtered.length ? (
              <div className="max-h-[68vh] overflow-auto bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-100">
                {hiddenEntryCount > 0 && (
                  <div className="sticky top-0 z-10 mb-2 flex justify-center bg-slate-950/95 py-1 backdrop-blur">
                    <button type="button" onClick={() => setRenderLimit((value) => value + LOG_RENDER_BATCH)} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] font-semibold text-sky-300 hover:border-sky-700">
                      加载更早 {Math.min(LOG_RENDER_BATCH, hiddenEntryCount)} 行（尚有 {hiddenEntryCount} 行）
                    </button>
                  </div>
                )}
                <div className="min-w-[680px] space-y-0.5">
                  {visibleEntries.map((entry) => <div key={entry.id} className="grid grid-cols-[42px_72px_52px_minmax(0,1fr)] gap-2 rounded px-2 py-0.5 hover:bg-white/5"><span className="text-right text-slate-600">{entry.lineNumber}</span><span className={entry.timestampSource === "line" || entry.timestampSource === "loki" ? "text-slate-300" : "text-slate-600"}>{formatLogTimestamp(entry.timestamp)}</span><span className={logLevelClass(entry.level)}>{entry.level ?? "-"}</span><span className="whitespace-pre-wrap break-words text-slate-100">{entry.raw}</span></div>)}
                </div>
              </div>
            ) : <EmptyState title="没有匹配的日志" description="调整搜索、级别或时间范围后再试。" className="border-0 py-16" />
          ) : <EmptyState icon={<ScrollText className="h-5 w-5" />} title="当前日志源不可用" description={active?.error ?? "启动对应服务后刷新运行状态。"} className="border-0 py-16" />}
        </section>
      </div>
    </div>
  );
}
