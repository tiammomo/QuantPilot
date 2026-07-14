"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Bell,
  BookOpenCheck,
  CheckCircle2,
  FileText,
  Gauge,
  Layers3,
  Loader2,
  Play,
  Radar,
  RefreshCw,
  Rss,
  Send,
  ShieldAlert,
  Sparkles,
  Workflow,
} from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { SubNav, type SubNavItem } from "@/components/layout/SubNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ResearchAutomationDashboard,
  ResearchReportSnapshot,
} from "@/lib/quant/research-reports";
import {
  ResearchMetricCard,
  ResearchSectionHeader,
  ResearchStatusBadge,
  riskClass,
  riskLabel,
  scoreTone,
} from "./ResearchConsolePrimitives";
import { ResearchReportLibrary } from "./ResearchReportLibrary";
import { ResearchInsightsView } from "./ResearchInsightsView";
import { ResearchAutomationView } from "./ResearchAutomationView";
import { formatResearchTime, reportCandidates, reportCoverage, reportRisks } from "./researchViewModel";

export type ResearchView = "overview" | "reports" | "insights" | "automation";

type Props = {
  initialData: ResearchAutomationDashboard;
  initialView?: ResearchView;
};

type ApiResponse<T> = { success: boolean; data?: T; error?: string; message?: string };

const VIEW_ITEMS: SubNavItem[] = [
  { id: "overview", label: "研究总览", icon: <Gauge className="h-4 w-4" /> },
  { id: "reports", label: "报告库", icon: <FileText className="h-4 w-4" /> },
  { id: "insights", label: "主题洞察", icon: <Radar className="h-4 w-4" /> },
  { id: "automation", label: "源与自动化", icon: <Workflow className="h-4 w-4" /> },
];

function isResearchView(value: string | null): value is ResearchView {
  return VIEW_ITEMS.some((item) => item.id === value);
}

function LatestResearchCard({ report, onOpenReports, onSend, isSending }: {
  report: ResearchReportSnapshot;
  onOpenReports: () => void;
  onSend: () => void;
  isSending: boolean;
}) {
  const candidates = reportCandidates(report);
  const coverage = reportCoverage(report);
  const risks = reportRisks(report);
  return (
    <article className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-[0_24px_54px_-40px_hsl(var(--shadow-color)/0.6)]">
      <div className="border-b border-border/50 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_42%),hsl(var(--card))] p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 max-w-3xl"><div className="flex flex-wrap items-center gap-2"><Badge className={cn("hover:bg-inherit", riskClass(report.riskLevel))}>{riskLabel(report.riskLevel)}</Badge><Badge variant="outline" className="text-muted-foreground">{formatResearchTime(report.createdAt)}</Badge></div><h3 className="mt-3 text-xl font-black leading-8 text-foreground">{report.title}</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">{report.summary}</p></div>
          <div className="shrink-0 text-left sm:text-right"><p className={cn("text-4xl font-black tabular-nums", scoreTone(report.score))}>{report.score}</p><p className="mt-1 text-[11px] text-muted-foreground">研究评分 / 100</p></div>
        </div>
      </div>
      <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          <p className="text-[10px] font-bold tracking-[0.14em] text-primary">CORE RECOMMENDATION</p><p className="mt-2 text-base font-bold leading-7 text-foreground">{report.recommendation}</p>
          <div className="mt-5 grid grid-cols-3 gap-2"><div className="rounded-lg bg-muted/45 p-3"><p className="text-[10px] text-muted-foreground">候选标的</p><p className="mt-1 text-lg font-black text-foreground">{candidates.length}</p></div><div className="rounded-lg bg-muted/45 p-3"><p className="text-[10px] text-muted-foreground">股票池覆盖</p><p className="mt-1 text-lg font-black text-foreground">{coverage ? `${Math.round(coverage.coverageRatio * 100)}%` : "-"}</p></div><div className="rounded-lg bg-muted/45 p-3"><p className="text-[10px] text-muted-foreground">复核事项</p><p className="mt-1 text-lg font-black text-foreground">{risks.length}</p></div></div>
          {candidates.length > 0 && <div className="mt-5 flex flex-wrap gap-2">{candidates.slice(0, 5).map((candidate) => <Badge key={`${candidate.symbol}-${candidate.name}`} variant="outline" className="bg-background/60">{candidate.name} · {candidate.symbol}</Badge>)}</div>}
        </div>
        <div className="space-y-2"><p className="text-xs font-bold text-foreground">证据快照</p>{report.evidence.map((evidence) => <div key={`${evidence.source}-${evidence.capturedAt}`} className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/55 px-3 py-2.5"><span className="truncate text-xs font-medium text-foreground">{evidence.source}</span><ResearchStatusBadge status={evidence.status} /></div>)}</div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border/50 bg-muted/20 px-5 py-4 sm:px-6"><Button onClick={onOpenReports}>阅读完整报告 <ArrowRight className="h-4 w-4" /></Button><Button variant="outline" onClick={onSend} disabled={isSending}>{isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}推送报告</Button></div>
    </article>
  );
}

function ResearchPipeline({ data }: { data: ResearchAutomationDashboard }) {
  const stages = [
    { label: "观察范围", detail: `${data.summary.watchlists} 个观察池已落库`, status: data.summary.watchlists ? "available" : "unavailable", icon: <Rss className="h-4 w-4" /> },
    { label: "证据采样", detail: `${data.providerMatrix.filter((item) => item.status !== "disabled" && item.status !== "unavailable").length} 个来源可参与`, status: data.providerMatrix.some((item) => item.status === "available") ? "available" : "partial", icon: <Layers3 className="h-4 w-4" /> },
    { label: "报告合成", detail: data.summary.reports ? `${data.summary.reports} 份报告已沉淀` : "等待首次生成", status: data.summary.reports ? "completed" : "disabled", icon: <BookOpenCheck className="h-4 w-4" /> },
    { label: "推送交付", detail: `${data.summary.activeChannels} 个通道 · ${data.recentDeliveries.length} 条回执`, status: data.recentDeliveries[0]?.status ?? (data.summary.activeChannels ? "configured" : "disabled"), icon: <Bell className="h-4 w-4" /> },
  ];
  return (
    <section className="grid gap-2 md:grid-cols-4">{stages.map((stage, index) => <div key={stage.label} className="relative rounded-xl border border-border/60 bg-card p-4"><div className="flex items-start justify-between gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">{stage.icon}</span><span className="text-xs font-black text-muted-foreground">0{index + 1}</span></div><h3 className="mt-3 text-sm font-bold text-foreground">{stage.label}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{stage.detail}</p><div className="mt-3"><ResearchStatusBadge status={stage.status} /></div>{index < stages.length - 1 && <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 rounded-full bg-background p-0.5 text-primary md:block" />}</div>)}</section>
  );
}

function OverviewView({ data, onViewChange, onSend, isSending }: {
  data: ResearchAutomationDashboard;
  onViewChange: (view: ResearchView) => void;
  onSend: (reportId?: string) => void;
  isSending: boolean;
}) {
  const latest = data.latestReports[0] ?? null;
  const availableProviders = data.providerMatrix.filter((provider) => provider.status === "available" || provider.status === "partial").length;
  const dryRunChannels = data.notificationChannels.filter((channel) => channel.isDryRun).length;
  const latestRun = data.recentRuns[0] ?? null;
  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.16),transparent_42%),linear-gradient(135deg,hsl(var(--card)),hsl(var(--muted)/0.48))] p-5 shadow-[0_30px_70px_-52px_hsl(var(--primary)/0.5)] sm:p-7">
        <div className="absolute -right-12 -top-16 h-52 w-52 rounded-full border border-primary/15" />
        <div className="relative flex flex-col gap-7 xl:flex-row xl:items-center xl:justify-between">
          <div className="max-w-3xl"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">RESEARCH INTELLIGENCE</Badge><ResearchStatusBadge status={latest ? "available" : "partial"} label={latest ? "研究样本已就绪" : "等待首份日报"} /></div><h2 className="mt-4 text-2xl font-black tracking-tight text-foreground sm:text-3xl">{latest ? "从证据出发，持续沉淀可复核的研究结论" : "研究链路已经就绪，等待生成首份证据型日报"}</h2><p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">把观察池、行情覆盖、候选筛选、分析层和推送回执串成完整链路。报告是研究材料，不是即时交易指令，所有结论保留证据与人工复核边界。</p><div className="mt-5"><Button variant="outline" onClick={() => onViewChange(latest ? "reports" : "automation")}>{latest ? "阅读最新报告" : "检查生成条件"}<ArrowRight className="h-4 w-4" /></Button></div></div>
          <div className="grid min-w-0 grid-cols-3 gap-2 sm:gap-3 xl:min-w-[470px]"><div className="rounded-xl border border-border/60 bg-background/70 p-3 backdrop-blur sm:p-4"><p className="text-[10px] text-muted-foreground sm:text-xs">研究评分</p><p className={cn("mt-1.5 text-2xl font-black tabular-nums sm:mt-2 sm:text-4xl", scoreTone(data.summary.latestScore))}>{data.summary.latestScore ?? "-"}</p><p className="mt-1 hidden text-[11px] text-muted-foreground sm:block">最新结构化报告</p></div><div className="rounded-xl border border-border/60 bg-background/70 p-3 backdrop-blur sm:p-4"><p className="text-[10px] text-muted-foreground sm:text-xs">证据源</p><p className="mt-1.5 text-2xl font-black tabular-nums text-foreground sm:mt-2 sm:text-4xl">{availableProviders}/{data.providerMatrix.length}</p><p className="mt-1 hidden text-[11px] text-muted-foreground sm:block">可用或支持降级</p></div><div className="rounded-xl border border-border/60 bg-background/70 p-3 backdrop-blur sm:p-4"><p className="text-[10px] text-muted-foreground sm:text-xs">报告资产</p><p className="mt-1.5 text-2xl font-black tabular-nums text-foreground sm:mt-2 sm:text-4xl">{data.summary.reports}</p><p className="mt-1 hidden text-[11px] text-muted-foreground sm:block">{latestRun ? `${latestRun.runType} · ${latestRun.status}` : "暂无运行"}</p></div></div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <ResearchMetricCard icon={<Rss className="h-4 w-4" />} label="观察池" value={data.summary.watchlists} helper={`${data.watchlists.reduce((sum, item) => sum + item.symbols.length, 0)} 个核心标的`} tone="blue" />
        <ResearchMetricCard icon={<FileText className="h-4 w-4" />} label="累计报告" value={data.summary.reports} helper={`${data.latestReports.length} 份近期报告可读`} tone={data.summary.reports ? "emerald" : "slate"} />
        <ResearchMetricCard icon={<Bell className="h-4 w-4" />} label="推送通道" value={data.summary.activeChannels} helper={`${dryRunChannels} 个为 dry-run`} tone="violet" />
        <ResearchMetricCard icon={<CheckCircle2 className="h-4 w-4" />} label="近期运行" value={data.recentRuns.length} helper={`${data.recentRuns.filter((run) => run.status === "completed").length} 次完成`} tone={data.recentRuns.length ? "emerald" : "slate"} />
      </section>

      <section className="space-y-4"><ResearchSectionHeader eyebrow="RESEARCH PIPELINE" title="研究生产链路" description="从研究范围到证据采样、报告合成与推送交付，每个阶段都保留状态事实。" /><ResearchPipeline data={data} /></section>

      {latest ? <section className="space-y-4"><ResearchSectionHeader eyebrow="LATEST BRIEF" title="最新研究摘要" description="优先展示最新评分、建议、候选、覆盖率和证据状态。" action={<Button variant="ghost" size="sm" onClick={() => onViewChange("reports")}>查看全部报告 <ArrowRight className="h-3.5 w-3.5" /></Button>} /><LatestResearchCard report={latest} onOpenReports={() => onViewChange("reports")} onSend={() => onSend(latest.id)} isSending={isSending} /></section> : (
        <section className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]"><div className="rounded-2xl border border-dashed border-primary/25 bg-card px-6 py-10 text-center sm:py-12"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles className="h-5 w-5" /></span><h3 className="mt-4 text-xl font-black text-foreground">首份日报会沉淀哪些内容？</h3><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">候选标的、股票池覆盖、综合评分、风险等级、研究建议、证据状态与人工复核清单。</p><Button variant="outline" className="mt-4" onClick={() => onViewChange("automation")}>检查生成条件<ArrowRight className="h-4 w-4" /></Button></div><div className="rounded-2xl border border-border/60 bg-card p-5"><h3 className="text-base font-bold text-foreground">当前研究边界</h3><div className="mt-4 space-y-3">{["使用本地 market-data 与股票池事实，不拼装未知外部 API。", "ClickHouse 不可用时保留 TimescaleDB 稳定回退路径。", "新闻与舆情源尚未启用，不会伪造事件结论。", "日报只作为研究与复核材料，不输出确定性买卖指令。"].map((item) => <div key={item} className="flex items-start gap-2 text-sm leading-6 text-muted-foreground"><ShieldAlert className="mt-1 h-4 w-4 shrink-0 text-amber-500" />{item}</div>)}</div></div></section>
      )}

      <section className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-4"><ResearchSectionHeader eyebrow="WATCHLIST" title="研究范围" description="当前日报所覆盖的股票池、标的、市场和计划。" /><div className="space-y-3">{data.watchlists.map((watchlist) => <article key={watchlist.id} className="rounded-xl border border-border/60 bg-card p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-bold text-foreground">{watchlist.name}</h3><p className="mt-1 text-xs text-muted-foreground">{watchlist.universeId ?? "未绑定股票池"}</p></div><ResearchStatusBadge status={watchlist.status} /></div><p className="mt-3 text-sm leading-6 text-muted-foreground">{watchlist.description}</p><div className="mt-4 flex flex-wrap gap-1.5">{watchlist.symbols.map((symbol) => <Badge key={symbol} variant="outline" className="font-mono text-[10px]">{symbol}</Badge>)}{watchlist.markets.map((market) => <Badge key={market} className="bg-primary/10 text-[10px] text-primary hover:bg-primary/10">{market}</Badge>)}</div></article>)}</div></div>
        <div className="space-y-4"><ResearchSectionHeader eyebrow="SOURCE READINESS" title="证据源状态" description="在生成前明确哪些来源可用、降级或未启用。" action={<Button variant="outline" size="sm" onClick={() => onViewChange("automation")}>查看自动化链路</Button>} /><div className="grid gap-2 sm:grid-cols-2">{data.providerMatrix.map((provider) => <article key={provider.id} className="rounded-xl border border-border/60 bg-card p-4"><div className="flex items-start justify-between gap-2"><h3 className="text-sm font-bold text-foreground">{provider.name}</h3><ResearchStatusBadge status={provider.status} /></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{provider.detail}</p></article>)}</div></div>
      </section>
    </div>
  );
}

export default function ResearchReportsClient({ initialData, initialView = "overview" }: Props) {
  const [view, setView] = useState<ResearchView>(initialView);
  const [data, setData] = useState(initialData);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const updateUrl = useCallback((nextView: ResearchView) => {
    const url = new URL(window.location.href);
    if (nextView === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", nextView);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const changeView = useCallback((nextView: ResearchView) => {
    setView(nextView);
    updateUrl(nextView);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [updateUrl]);

  useEffect(() => {
    const applyLocation = () => {
      const requested = new URL(window.location.href).searchParams.get("view");
      setView(isResearchView(requested) ? requested : "overview");
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, []);

  const refresh = async () => {
    setIsRefreshing(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/research/reports", { cache: "no-store" });
      const payload = await response.json() as ApiResponse<ResearchAutomationDashboard>;
      if (!response.ok || !payload.success || !payload.data) throw new Error(payload.message || payload.error || "刷新失败");
      setData(payload.data);
      setFeedback({ type: "success", message: "研究状态已刷新" });
    } catch (error) {
      setFeedback({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRefreshing(false);
    }
  };

  const runDailyReport = async () => {
    setIsRunning(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/research/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run-daily-report", dryRun: true }) });
      const payload = await response.json() as ApiResponse<ResearchAutomationDashboard>;
      if (!response.ok || !payload.success || !payload.data) throw new Error(payload.message || payload.error || "生成日报失败");
      setData(payload.data);
      setFeedback({ type: "success", message: "研究日报已生成，证据与 dry-run 推送记录已保存" });
    } catch (error) {
      setFeedback({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRunning(false);
    }
  };

  const sendReport = async (reportId?: string) => {
    setIsSending(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/research/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send-latest-report", reportId, dryRun: false }) });
      const payload = await response.json() as ApiResponse<ResearchAutomationDashboard>;
      if (!response.ok || !payload.success || !payload.data) throw new Error(payload.message || payload.error || "推送失败");
      setData(payload.data);
      setFeedback({ type: "success", message: "推送请求已完成，回执已更新" });
    } catch (error) {
      setFeedback({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsSending(false);
    }
  };

  const latestRun = data.recentRuns[0] ?? null;
  const generatedAt = data.generatedAt ?? latestRun?.finishedAt ?? latestRun?.startedAt ?? null;
  return (
    <div className="platform-shell">
      <PageHeader compactOnMobile title="投研情报中心" badge={<Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">{data.summary.reports} 份研究报告</Badge>} subtitle={`观察池、证据、报告与交付闭环 · 更新于 ${formatResearchTime(generatedAt)}`} />
      <SubNav compactOnMobile items={VIEW_ITEMS} activeId={view} onChange={(id) => changeView(id as ResearchView)} actions={<div className="flex items-center gap-2"><Button aria-label="刷新研究状态" title="刷新研究状态" variant="outline" size="sm" onClick={refresh} disabled={isRefreshing || isRunning || isSending}><RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} /><span className="hidden sm:inline">刷新</span></Button><Button aria-label="生成研究日报" title="生成研究日报" size="sm" onClick={runDailyReport} disabled={isRunning || isRefreshing || isSending}>{isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}<span className="hidden sm:inline">生成日报</span></Button></div>} />
      <main className="platform-content mx-auto max-w-[1520px] space-y-6 px-3 py-5 sm:px-6 sm:py-7 lg:px-8">
        {feedback && <div role="status" className={cn("rounded-xl border px-4 py-3 text-sm", feedback.type === "success" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-500" : "border-red-500/25 bg-red-500/10 text-red-500")}>{feedback.message}</div>}
        {view === "overview" && <OverviewView data={data} onViewChange={changeView} onSend={sendReport} isSending={isSending} />}
        {view === "reports" && <ResearchReportLibrary reports={data.latestReports} onOpenAutomation={() => changeView("automation")} onSend={(id) => sendReport(id)} isSending={isSending} />}
        {view === "insights" && <ResearchInsightsView data={data} />}
        {view === "automation" && <ResearchAutomationView data={data} onSend={sendReport} isSending={isSending} />}
        {latestRun?.status === "running" && <div className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-xl border border-blue-500/25 bg-card px-4 py-3 text-sm text-blue-500 shadow-xl"><Loader2 className="h-4 w-4 animate-spin" />日报正在运行</div>}
      </main>
    </div>
  );
}
