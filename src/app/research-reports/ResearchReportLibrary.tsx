"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  FileSearch,
  FileText,
  Loader2,
  Search,
  Send,
  ShieldAlert,
  Target,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { ResearchReportSnapshot } from "@/lib/quant/research-reports";
import {
  ResearchSectionHeader,
  ResearchStatusBadge,
  riskClass,
  riskLabel,
  scoreTone,
} from "./ResearchConsolePrimitives";
import { formatResearchTime, reportCandidates, reportCoverage, reportRisks } from "./researchViewModel";

type RiskFilter = "all" | "low" | "medium" | "high";

function MarkdownDocument({ content }: { content: string }) {
  const blocks = useMemo(() => {
    const lines = content.split(/\r?\n/);
    const output: Array<{ kind: "h1" | "h2" | "list" | "p"; value: string | string[] }> = [];
    let list: string[] = [];
    const flush = () => {
      if (list.length) output.push({ kind: "list", value: list.splice(0) });
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { flush(); continue; }
      if (line.startsWith("# ")) { flush(); output.push({ kind: "h1", value: line.slice(2) }); continue; }
      if (line.startsWith("## ")) { flush(); output.push({ kind: "h2", value: line.slice(3) }); continue; }
      if (line.startsWith("- ")) { list.push(line.slice(2)); continue; }
      flush();
      output.push({ kind: "p", value: line });
    }
    flush();
    return output;
  }, [content]);

  return (
    <div className="space-y-4 text-sm leading-7 text-foreground">
      {blocks.map((block, index) => {
        if (block.kind === "h1") return <h2 key={index} className="text-xl font-black tracking-tight text-foreground">{block.value}</h2>;
        if (block.kind === "h2") return <h3 key={index} className="border-b border-border/50 pb-2 pt-2 text-base font-bold text-foreground">{block.value}</h3>;
        if (block.kind === "list") return <ul key={index} className="space-y-2">{(block.value as string[]).map((item, itemIndex) => <li key={`${item}-${itemIndex}`} className="flex items-start gap-2"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><span>{item}</span></li>)}</ul>;
        return <p key={index} className="text-muted-foreground">{block.value}</p>;
      })}
    </div>
  );
}

function ReportCard({ report, onOpen }: { report: ResearchReportSnapshot; onOpen: () => void }) {
  const candidates = reportCandidates(report);
  const coverage = reportCoverage(report);
  return (
    <button type="button" onClick={onOpen} className="group flex min-h-[280px] flex-col rounded-xl border border-border/65 bg-card/90 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)]">
      <div className="flex items-start justify-between gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><FileText className="h-5 w-5" /></span>
        <div className="text-right"><p className={cn("text-2xl font-black tabular-nums", scoreTone(report.score))}>{report.score}</p><p className="text-[10px] text-muted-foreground">研究评分</p></div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2"><Badge className={cn("hover:bg-inherit", riskClass(report.riskLevel))}>{riskLabel(report.riskLevel)}</Badge><Badge variant="outline" className="text-[10px] text-muted-foreground">{formatResearchTime(report.createdAt)}</Badge></div>
      <h3 className="mt-3 line-clamp-2 text-base font-bold leading-6 text-foreground group-hover:text-primary">{report.title}</h3>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{report.summary}</p>
      <div className="mt-4 grid grid-cols-2 gap-2 text-center">
        <div className="rounded-lg bg-muted/45 px-2 py-2"><p className="text-[10px] text-muted-foreground">候选标的</p><p className="mt-1 text-sm font-bold text-foreground">{candidates.length}</p></div>
        <div className="rounded-lg bg-muted/45 px-2 py-2"><p className="text-[10px] text-muted-foreground">股票池覆盖</p><p className="mt-1 text-sm font-bold text-foreground">{coverage ? `${Math.round(coverage.coverageRatio * 100)}%` : "-"}</p></div>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border/40 pt-4 text-xs"><span className="truncate text-muted-foreground">{report.source}</span><span className="inline-flex items-center gap-1 font-semibold text-primary">阅读报告 <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span></div>
    </button>
  );
}

function ReportDetail({ report, open, onOpenChange, onSend, isSending }: {
  report: ResearchReportSnapshot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (reportId: string) => void;
  isSending: boolean;
}) {
  if (!report) return null;
  const candidates = reportCandidates(report);
  const coverage = reportCoverage(report);
  const risks = reportRisks(report);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[min(820px,calc(100vw-16px))] max-w-none flex-col gap-0 overflow-hidden border-l border-border bg-background p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border/50 bg-card/80 px-5 py-5 text-left">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><SheetTitle className="text-lg">{report.title}</SheetTitle><Badge className={cn("hover:bg-inherit", riskClass(report.riskLevel))}>{riskLabel(report.riskLevel)}</Badge></div><SheetDescription className="mt-1 leading-5">{formatResearchTime(report.createdAt, true)} · {report.source}</SheetDescription></div>
            <p className={cn("text-3xl font-black tabular-nums", scoreTone(report.score))}>{report.score}</p>
          </div>
        </SheetHeader>
        <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
          <section className="rounded-xl border border-primary/20 bg-primary/5 p-4"><p className="text-sm font-bold text-foreground">{report.summary}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">研究建议：{report.recommendation}</p></section>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-border/60 bg-card p-3 text-center"><p className="text-[10px] text-muted-foreground">评分</p><p className={cn("mt-1 text-lg font-black", scoreTone(report.score))}>{report.score}</p></div>
            <div className="rounded-lg border border-border/60 bg-card p-3 text-center"><p className="text-[10px] text-muted-foreground">候选</p><p className="mt-1 text-lg font-black text-foreground">{candidates.length}</p></div>
            <div className="rounded-lg border border-border/60 bg-card p-3 text-center"><p className="text-[10px] text-muted-foreground">证据</p><p className="mt-1 text-lg font-black text-foreground">{report.evidence.length}</p></div>
            <div className="rounded-lg border border-border/60 bg-card p-3 text-center"><p className="text-[10px] text-muted-foreground">覆盖率</p><p className="mt-1 text-lg font-black text-foreground">{coverage ? `${Math.round(coverage.coverageRatio * 100)}%` : "-"}</p></div>
          </div>

          {candidates.length > 0 && <section><h3 className="flex items-center gap-2 text-sm font-bold text-foreground"><Target className="h-4 w-4 text-primary" />候选标的</h3><div className="mt-3 grid gap-2 sm:grid-cols-2">{candidates.map((candidate) => <div key={`${candidate.symbol}-${candidate.name}`} className="rounded-xl border border-border/60 bg-card p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold text-foreground">{candidate.name}</p><p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{candidate.symbol}</p></div><p className={cn("text-sm font-black", candidate.changePercent != null && candidate.changePercent >= 0 ? "text-red-500" : "text-emerald-500")}>{candidate.changePercent == null ? "-" : `${candidate.changePercent >= 0 ? "+" : ""}${candidate.changePercent.toFixed(2)}%`}</p></div><div className="mt-3 flex flex-wrap gap-1.5">{candidate.signals.slice(0, 3).map((signal) => <Badge key={signal} variant="outline" className="text-[10px]">{signal}</Badge>)}</div></div>)}</div></section>}

          <section><h3 className="flex items-center gap-2 text-sm font-bold text-foreground"><FileSearch className="h-4 w-4 text-primary" />研究正文</h3><div className="mt-3 rounded-xl border border-border/60 bg-card p-5"><MarkdownDocument content={report.contentMarkdown} /></div></section>

          <section><h3 className="flex items-center gap-2 text-sm font-bold text-foreground"><CheckCircle2 className="h-4 w-4 text-primary" />证据来源</h3><div className="mt-3 grid gap-2 sm:grid-cols-2">{report.evidence.map((evidence) => <div key={`${evidence.source}-${evidence.capturedAt}`} className="rounded-xl border border-border/60 bg-card p-4"><div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold text-foreground">{evidence.source}</p><ResearchStatusBadge status={evidence.status} /></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{evidence.detail}</p><p className="mt-2 text-[10px] text-muted-foreground">采样于 {formatResearchTime(evidence.capturedAt)}</p></div>)}</div></section>

          {risks.length > 0 && <section><h3 className="flex items-center gap-2 text-sm font-bold text-foreground"><ShieldAlert className="h-4 w-4 text-amber-500" />风险与复核清单</h3><div className="mt-3 space-y-2">{risks.map((risk) => <div key={risk} className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm leading-6 text-foreground"><ShieldAlert className="mt-1 h-3.5 w-3.5 shrink-0 text-amber-500" />{risk}</div>)}</div></section>}
        </div>
        <div className="border-t border-border/50 bg-card/80 p-4"><Button onClick={() => onSend(report.id)} disabled={isSending}>{isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}推送这份报告</Button></div>
      </SheetContent>
    </Sheet>
  );
}

export function ResearchReportLibrary({ reports, onOpenAutomation, onSend, isSending }: {
  reports: ResearchReportSnapshot[];
  onOpenAutomation: () => void;
  onSend: (reportId: string) => void;
  isSending: boolean;
}) {
  const [keyword, setKeyword] = useState("");
  const [risk, setRisk] = useState<RiskFilter>("all");
  const [selected, setSelected] = useState<ResearchReportSnapshot | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    return reports.filter((report) => {
      if (risk !== "all" && report.riskLevel !== risk) return false;
      if (!lower) return true;
      const candidates = reportCandidates(report);
      return [report.title, report.summary, report.recommendation, report.source, ...candidates.flatMap((item) => [item.name, item.symbol])].join(" ").toLowerCase().includes(lower);
    });
  }, [keyword, reports, risk]);
  return (
    <div className="space-y-6 sm:space-y-7">
      <ResearchSectionHeader eyebrow="REPORT LIBRARY" title="研究报告库" description="保留评分、风险、候选标的、证据和复核清单，每份日报都可以回到生成时的事实现场。" />
      <section className="flex flex-col gap-3 sm:flex-row">
        <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索标题、候选标的、建议或来源" className="h-10 bg-card pl-9" aria-label="搜索研究报告" /></div>
        <div className="flex flex-wrap gap-1.5">{(["all", "high", "medium", "low"] as RiskFilter[]).map((item) => { const label = item === "all" ? "全部风险" : riskLabel(item); return <button key={item} type="button" onClick={() => setRisk(item)} className={cn("rounded-lg border px-3 py-2 text-xs font-semibold", risk === item ? "border-primary/30 bg-primary/10 text-primary" : "border-border/60 bg-card text-muted-foreground")}>{label}</button>; })}</div>
      </section>
      {filtered.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((report) => <ReportCard key={report.id} report={report} onOpen={() => { setSelected(report); setDetailOpen(true); }} />)}</div> : reports.length ? <EmptyState icon={<FileSearch className="h-5 w-5" />} title="没有匹配的报告" description="调整关键词或风险筛选后再试。" className="rounded-xl border border-border/60 bg-card py-10 sm:py-12" /> : <section data-research-empty className="rounded-2xl border border-dashed border-primary/25 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_38%),hsl(var(--card))] px-5 py-10 text-center sm:px-6 sm:py-12"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><CalendarDays className="h-5 w-5" /></span><h3 className="mt-4 text-xl font-black text-foreground">报告库等待首份研究日报</h3><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">系统会从观察池采样行情覆盖、候选筛选和分析层状态，生成结构化报告并保存完整证据。</p><div className="mx-auto mt-4 flex max-w-xl flex-wrap justify-center gap-2"><Badge variant="outline" className="bg-background/60">采样行情覆盖</Badge><Badge variant="outline" className="bg-background/60">生成候选与评分</Badge><Badge variant="outline" className="bg-background/60">保存证据与复核项</Badge></div><Button variant="outline" className="mt-4" onClick={onOpenAutomation}>检查生成条件<ArrowRight className="h-4 w-4" /></Button></section>}
      <ReportDetail report={selected} open={detailOpen} onOpenChange={setDetailOpen} onSend={onSend} isSending={isSending} />
    </div>
  );
}
