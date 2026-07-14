"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Braces,
  Clock3,
  GitBranch,
  ListChecks,
  Play,
  Search,
  TerminalSquare,
  TriangleAlert,
  XCircle,
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
import { formatCompactDate as formatDate } from "@/components/quant/console-primitives";
import {
  TimelineItem,
  traceDotClass,
  traceStageIcon,
  traceStatusLabel,
} from "@/components/quant/workspace-console-primitives";
import { cn } from "@/lib/utils";
import type {
  GenerationObservabilityDashboard,
  GenerationStageId,
  GenerationTraceProject,
  GenerationTraceStatus,
} from "@/lib/quant/generation-observability";
import { OpsMetricCard, OpsSectionHeader } from "./OpsConsolePrimitives";

type TraceFilter = GenerationTraceStatus | "all";
const PAGE_SIZE = 10;

function traceStatusClass(status: GenerationTraceStatus) {
  if (status === "success") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-500";
  if (status === "warning") return "border-amber-500/25 bg-amber-500/10 text-amber-500";
  if (status === "error") return "border-red-500/25 bg-red-500/10 text-red-500";
  if (status === "pending") return "border-blue-500/25 bg-blue-500/10 text-blue-500";
  return "border-border bg-muted text-muted-foreground";
}

function TraceCard({ project, onOpen }: { project: GenerationTraceProject; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group w-full rounded-xl border border-border/60 bg-card/90 p-4 text-left shadow-[0_16px_38px_-32px_hsl(var(--shadow-color)/0.55)] transition-all hover:border-primary/35 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><GitBranch className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-bold text-foreground group-hover:text-primary">{project.name}</h3>
            <Badge className={cn("hover:bg-inherit", traceStatusClass(project.trace.status))}>{traceStatusLabel[project.trace.status]}</Badge>
            {project.trace.activeStage && <Badge variant="outline" className="bg-background/50 text-[10px] text-muted-foreground">{project.trace.activeStage}</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">{project.trace.summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>{project.trace.eventCount} 事件</span>
            <span>{project.trace.requestCount} 请求</span>
            <span>{project.trace.toolCallCount} 工具调用</span>
            <span>{project.trace.errorCount} 错误</span>
            <span>{formatDate(project.trace.lastEventAt)}</span>
          </div>
        </div>
        <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary sm:block" />
      </div>
      <div className="mt-4 grid grid-cols-4 gap-1.5 sm:grid-cols-8">
        {project.stages.filter((stage) => stage.id !== "system").map((stage) => (
          <div key={stage.id} className="rounded-lg border border-border/50 bg-background/45 px-2 py-2">
            <div className="flex items-center justify-between gap-1"><span className="flex items-center gap-1 truncate text-[10px] font-medium text-muted-foreground">{traceStageIcon(stage.id)}{stage.label}</span><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", traceDotClass(stage.status))} /></div>
          </div>
        ))}
      </div>
    </button>
  );
}

function TraceDetail({ project, open, onOpenChange }: { project: GenerationTraceProject | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [stage, setStage] = useState<GenerationStageId | "all">("all");
  if (!project) return null;
  const timeline = project.timeline.filter((event) => stage === "all" || event.stage === stage);
  return (
    <Sheet open={open} onOpenChange={(value) => { onOpenChange(value); if (!value) setStage("all"); }}>
      <SheetContent side="right" className="flex w-[min(780px,calc(100vw-16px))] max-w-none flex-col gap-0 overflow-hidden border-l border-border bg-background p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border/50 bg-card/80 px-5 py-5 text-left">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><SheetTitle className="text-lg">{project.name}</SheetTitle><Badge className={cn("hover:bg-inherit", traceStatusClass(project.trace.status))}>{traceStatusLabel[project.trace.status]}</Badge></div>
              <SheetDescription className="mt-1 leading-5">{project.trace.summary} · {formatDate(project.trace.lastEventAt)}</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["链路事件", project.trace.eventCount],
              ["用户请求", project.trace.requestCount],
              ["工具调用", project.trace.toolCallCount],
              ["错误 / 警告", `${project.trace.errorCount} / ${project.trace.warningCount}`],
            ].map(([label, value]) => <div key={label} className="rounded-lg border border-border/60 bg-card p-3 text-center"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 text-lg font-bold text-foreground">{value}</p></div>)}
          </div>

          {project.nextActions.length > 0 && (
            <section className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-500"><TriangleAlert className="h-4 w-4" />下一步动作</h3>
              <div className="mt-2 space-y-1.5">{project.nextActions.map((action) => <p key={action} className="text-xs leading-5 text-foreground">• {action}</p>)}</div>
            </section>
          )}

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Activity className="h-4 w-4 text-primary" />生成阶段</h3>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {project.stages.map((item) => (
                <button key={item.id} type="button" onClick={() => setStage(stage === item.id ? "all" : item.id)} className={cn("rounded-lg border p-3 text-left transition-colors", stage === item.id ? "border-primary/35 bg-primary/10" : "border-border/60 bg-card hover:border-primary/25")}>
                  <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1 text-xs font-semibold text-foreground">{traceStageIcon(item.id)}{item.label}</span><span className={cn("h-2 w-2 rounded-full", traceDotClass(item.status))} /></div>
                  <p className="mt-1 text-[10px] text-muted-foreground">{item.eventCount} 事件</p>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><GitBranch className="h-4 w-4 text-primary" />链路时间线</h3>{stage !== "all" && <Button variant="ghost" size="sm" onClick={() => setStage("all")}>清除筛选</Button>}</div>
            {timeline.length ? <div className="mt-3 space-y-3 rounded-xl border border-border/50 bg-card/60 p-3">{timeline.map((event) => <TimelineItem key={event.id} event={event} />)}</div> : <EmptyState title="当前阶段没有事件" description="选择其他阶段查看链路事实。" className="mt-3 rounded-xl border border-border/60 bg-card py-10" />}
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><ListChecks className="h-4 w-4 text-primary" />运行事实</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-card p-4">
                <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Play className="h-3.5 w-3.5" />队列状态</p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center"><div><p className="text-lg font-bold text-blue-500">{project.generationQueue.running}</p><p className="text-[10px] text-muted-foreground">运行中</p></div><div><p className="text-lg font-bold text-foreground">{project.generationQueue.queued}</p><p className="text-[10px] text-muted-foreground">排队</p></div><div><p className="text-lg font-bold text-red-500">{project.generationQueue.failed}</p><p className="text-[10px] text-muted-foreground">失败</p></div></div>
              </div>
              <div className="rounded-xl border border-border/60 bg-card p-4">
                <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Braces className="h-3.5 w-3.5" />状态机</p>
                <p className="mt-3 text-sm font-semibold text-foreground">{project.generationState?.activeStep ?? "暂无活动步骤"}</p>
                <p className="mt-1 text-xs text-muted-foreground">{project.generationState?.status ?? "未生成"} · 修复 {project.generationState?.repairAttemptCount ?? 0}/{project.generationState?.maxRepairAttempts ?? 0}</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-card p-4">
                <p className="text-xs font-semibold text-muted-foreground">交付验证</p>
                <p className="mt-3 text-sm font-semibold text-foreground">契约 {traceStatusLabel[project.artifactContracts.status]} · 视觉 {traceStatusLabel[project.visualValidation.status]}</p>
                <p className="mt-1 text-xs text-muted-foreground">验证失败 {project.validation.failedChecks} · 警告 {project.validation.warningChecks}</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-card p-4">
                <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><TerminalSquare className="h-3.5 w-3.5" />工具画像</p>
                <div className="mt-3 space-y-1.5">{project.topTools.slice(0, 4).map((tool) => <div key={tool.name} className="flex justify-between gap-3 text-xs"><span className="truncate text-muted-foreground">{tool.name}</span><span className="font-semibold text-foreground">×{tool.count}</span></div>)}{project.topTools.length === 0 && <p className="text-xs text-muted-foreground">暂无工具调用</p>}</div>
              </div>
            </div>
          </section>
        </div>
        <div className="border-t border-border/50 bg-card/80 p-4"><Button asChild className="w-full sm:w-auto"><Link href={`/${project.id}/chat`}>打开项目会话 <ArrowRight className="h-4 w-4" /></Link></Button></div>
      </SheetContent>
    </Sheet>
  );
}

export function OpsTraceView({ data }: { data: GenerationObservabilityDashboard }) {
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<GenerationTraceProject | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    return data.projects.filter((project) => {
      if (filter !== "all" && project.trace.status !== filter) return false;
      if (!lower) return true;
      return [project.id, project.name, project.description, project.selectedModel, project.preferredCli, project.latestRequest?.instruction, ...project.runPlan.symbols].filter(Boolean).join(" ").toLowerCase().includes(lower);
    });
  }, [data.projects, filter, keyword]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const projects = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const filters: Array<{ id: TraceFilter; label: string }> = [{ id: "all", label: "全部" }, { id: "error", label: "阻断" }, { id: "warning", label: "风险" }, { id: "pending", label: "运行中" }, { id: "success", label: "正常" }, { id: "unknown", label: "未知" }];
  return (
    <div className="space-y-7">
      <OpsSectionHeader eyebrow="GENERATION TRACE" title="生成链路观测" description="从请求、规划和数据获取一路追踪到产物、验证、修复与完成，定位失败发生在哪一段。" />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OpsMetricCard icon={<GitBranch className="h-4 w-4" />} label="纳入观测" value={data.summary.total} helper={`${data.summary.requests} 个请求 · ${data.summary.toolCalls} 次工具调用`} tone="primary" />
        <OpsMetricCard icon={<Play className="h-4 w-4" />} label="运行中" value={data.summary.running} helper="仍有 pending 阶段的项目" tone="blue" />
        <OpsMetricCard icon={<XCircle className="h-4 w-4" />} label="阻断 / 风险" value={`${data.summary.failed} / ${data.summary.warning}`} helper="优先检查最近失败链路" tone={data.summary.failed ? "red" : "amber"} />
        <OpsMetricCard icon={<Clock3 className="h-4 w-4" />} label="24 小时事件" value={data.summary.eventsLast24h} helper="最近生成链路动作" tone="emerald" />
      </section>
      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} placeholder="搜索项目、标的、模型或请求内容" className="h-10 bg-card pl-9" aria-label="搜索生成链路" /></div>
          <div className="flex flex-wrap gap-1.5">{filters.map((item) => <button key={item.id} type="button" onClick={() => { setFilter(item.id); setPage(1); }} className={cn("rounded-lg border px-3 py-2 text-xs font-semibold", filter === item.id ? "border-primary/30 bg-primary/10 text-primary" : "border-border/60 bg-card text-muted-foreground")}>{item.label}</button>)}</div>
        </div>
        <p className="text-right text-xs text-muted-foreground">显示 {filtered.length}/{data.projects.length} 个项目</p>
      </section>
      {projects.length ? <div className="space-y-3">{projects.map((project) => <TraceCard key={project.id} project={project} onOpen={() => { setSelected(project); setDetailOpen(true); }} />)}</div> : <EmptyState icon={<GitBranch className="h-5 w-5" />} title="没有匹配的链路" description="调整关键词或状态筛选后再试。" className="rounded-xl border border-border/60 bg-card py-16" />}
      {pageCount > 1 && <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card px-4 py-3 text-sm text-muted-foreground"><span>第 {safePage}/{pageCount} 页</span><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage === 1}>上一页</Button><Button variant="outline" size="sm" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={safePage === pageCount}>下一页</Button></div></div>}
      <TraceDetail project={selected} open={detailOpen} onOpenChange={setDetailOpen} />
    </div>
  );
}
