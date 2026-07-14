"use client";

import { useMemo } from "react";
import {
  CircleAlert,
  Database,
  Gauge,
  Layers3,
  Radar,
  Target,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { ResearchAutomationDashboard } from "@/lib/quant/research-reports";
import {
  ResearchMetricCard,
  ResearchSectionHeader,
  ResearchStatusBadge,
  scoreTone,
} from "./ResearchConsolePrimitives";
import { reportCandidates, reportCoverage, reportRisks, type ResearchCandidate } from "./researchViewModel";

type CandidateAggregate = ResearchCandidate & { appearances: number; reportScore: number };

export function ResearchInsightsView({ data }: {
  data: ResearchAutomationDashboard;
}) {
  const candidateRanking = useMemo(() => {
    const bySymbol = new Map<string, CandidateAggregate>();
    for (const report of data.latestReports) {
      for (const candidate of reportCandidates(report)) {
        const key = candidate.symbol || candidate.name;
        const previous = bySymbol.get(key);
        if (!previous || (candidate.score ?? 0) > (previous.score ?? 0)) {
          bySymbol.set(key, { ...candidate, appearances: (previous?.appearances ?? 0) + 1, reportScore: report.score });
        } else {
          previous.appearances += 1;
        }
      }
    }
    return Array.from(bySymbol.values()).sort((left, right) => (right.score ?? right.reportScore) - (left.score ?? left.reportScore));
  }, [data.latestReports]);

  const evidence = data.latestReports.flatMap((report) => report.evidence);
  const readyEvidence = evidence.filter((item) => item.status === "available").length;
  const averageScore = data.latestReports.length ? Math.round(data.latestReports.reduce((sum, report) => sum + report.score, 0) / data.latestReports.length) : null;
  const latestCoverage = data.latestReports[0] ? reportCoverage(data.latestReports[0]) : null;
  const risks = Array.from(new Set(data.latestReports.flatMap(reportRisks))).slice(0, 8);
  const signalCount = candidateRanking.reduce((sum, candidate) => sum + candidate.signals.length, 0);

  return (
    <div className="space-y-6 sm:space-y-8">
      <ResearchSectionHeader eyebrow="RESEARCH INSIGHTS" title="主题洞察与证据地图" description="从最近报告中聚合候选标的、证据可用性、覆盖范围和复核事项，观察反复出现的研究信号。" />
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <ResearchMetricCard icon={<Target className="h-4 w-4" />} label="候选标的" value={candidateRanking.length} helper={`${signalCount} 个结构化研究信号`} tone="primary" />
        <ResearchMetricCard icon={<Gauge className="h-4 w-4" />} label="平均研究评分" value={averageScore ?? "-"} helper={`${data.latestReports.length} 份近期报告`} tone={averageScore == null ? "slate" : averageScore >= 80 ? "emerald" : "amber"} />
        <ResearchMetricCard icon={<Database className="h-4 w-4" />} label="可用证据" value={evidence.length ? `${readyEvidence}/${evidence.length}` : "-"} helper="按最新报告证据快照统计" tone={readyEvidence ? "emerald" : "blue"} />
        <ResearchMetricCard icon={<Layers3 className="h-4 w-4" />} label="股票池覆盖" value={latestCoverage ? `${Math.round(latestCoverage.coverageRatio * 100)}%` : "待采样"} helper={latestCoverage ? `${latestCoverage.readyCount}/${latestCoverage.memberCount} 个成员就绪` : "首次日报会写入覆盖快照"} tone={latestCoverage ? "blue" : "slate"} />
      </section>

      <section className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <div className="flex flex-col gap-4">
          <ResearchSectionHeader eyebrow="CANDIDATE RADAR" title="候选标的雷达" description="按近期报告中的候选评分排序，并保留出现次数、涨跌与研究信号。" />
          {candidateRanking.length ? <div className="grid gap-3 md:grid-cols-2">{candidateRanking.map((candidate, index) => (
            <article key={`${candidate.symbol}-${candidate.name}`} className="rounded-xl border border-border/65 bg-card p-4 transition-colors hover:border-border">
              <div className="flex items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-black text-primary">{index + 1}</span><div><h3 className="font-bold text-foreground">{candidate.name}</h3><p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{candidate.symbol} · 出现 {candidate.appearances} 次</p></div></div><div className="text-right"><p className={cn("text-sm font-black", candidate.changePercent != null && candidate.changePercent >= 0 ? "text-red-500" : "text-emerald-500")}>{candidate.changePercent == null ? "-" : `${candidate.changePercent >= 0 ? "+" : ""}${candidate.changePercent.toFixed(2)}%`}</p><p className={cn("mt-1 text-xs font-bold", scoreTone(candidate.score))}>{candidate.score ?? candidate.reportScore} 分</p></div></div>
              <div className="mt-4 flex flex-wrap gap-1.5">{candidate.signals.length ? candidate.signals.slice(0, 5).map((signal) => <Badge key={signal} variant="outline" className="text-[10px]">{signal}</Badge>) : <span className="text-xs text-muted-foreground">暂无结构化信号</span>}</div>
            </article>
          ))}</div> : <EmptyState icon={<Radar className="h-5 w-5" />} title="主题洞察将在首份日报生成后形成" description="候选标的、评分、涨跌与信号会从结构化报告中自动聚合。" className="flex-1 rounded-xl border border-border/60 bg-card py-10 sm:py-12" />}
        </div>

        <div className="flex flex-col gap-4">
          <ResearchSectionHeader eyebrow="RESEARCH SCOPE" title="当前研究范围" description="日报覆盖的股票池、核心标的与市场范围。" />
          <div className="flex-1 space-y-3">{data.watchlists.map((watchlist) => <article key={watchlist.id} className="h-full rounded-xl border border-border/60 bg-card p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-bold text-foreground">{watchlist.name}</h3><p className="mt-1 break-all text-xs text-muted-foreground">{watchlist.universeId ?? "未绑定股票池"}</p></div><ResearchStatusBadge status={watchlist.status} /></div><p className="mt-3 text-sm leading-6 text-muted-foreground">{watchlist.description}</p><div className="mt-4 flex flex-wrap gap-1.5">{watchlist.symbols.map((symbol) => <Badge key={symbol} variant="outline" className="font-mono text-[10px]">{symbol}</Badge>)}{watchlist.markets.map((market) => <Badge key={market} className="bg-primary/10 text-[10px] text-primary hover:bg-primary/10">{market}</Badge>)}</div></article>)}</div>
        </div>
      </section>

      <section className={cn("grid items-stretch gap-5", risks.length ? "xl:grid-cols-2" : "xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]")}>
        <div className="flex flex-col gap-4">
          <ResearchSectionHeader eyebrow="EVIDENCE MAP" title="证据源准备度" description="报告生成前展示 provider 就绪边界，生成后由实际采样状态覆盖。" />
          <div className="grid gap-3 sm:grid-cols-2">{data.providerMatrix.map((provider) => <article key={provider.id} className="rounded-xl border border-border/60 bg-card p-4"><div className="flex items-start justify-between gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500"><Database className="h-4 w-4" /></span><ResearchStatusBadge status={provider.status} /></div><h3 className="mt-3 text-sm font-bold text-foreground">{provider.name}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{provider.role}</p><p className="mt-3 border-t border-border/40 pt-3 text-[11px] leading-5 text-muted-foreground">{provider.detail}</p></article>)}</div>
        </div>
        <div className="flex flex-col gap-4">
          <ResearchSectionHeader eyebrow="REVIEW QUEUE" title="研究复核清单" description="去重汇总近期报告中的数据、交易和风控复核事项。" />
          {risks.length ? <div className="space-y-2">{risks.map((risk, index) => <div key={risk} className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-xs font-black text-amber-500">{index + 1}</span><p className="text-sm leading-6 text-foreground">{risk}</p></div>)}</div> : <div className="flex-1 rounded-xl border border-border/60 bg-card p-5"><div className="flex items-start gap-3"><CircleAlert className="mt-0.5 h-5 w-5 text-amber-500" /><div><h3 className="font-bold text-foreground">等待研究样本</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">首份报告会生成数据覆盖、候选核验和风控复核清单。</p></div></div><div className="mt-5 space-y-2">{["数据覆盖等待报告快照", "候选标的等待结构化核验", "风险事项等待证据复核"].map((item) => <div key={item} className="flex items-center gap-2 rounded-lg bg-muted/45 px-3 py-2.5 text-xs text-muted-foreground"><CircleAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />{item}</div>)}</div></div>}
        </div>
      </section>
    </div>
  );
}
