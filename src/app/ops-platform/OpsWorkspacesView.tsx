"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FileText,
  Gauge,
  Loader2,
  Search,
  ShieldAlert,
  Sparkles,
  Wrench,
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
import { cn } from "@/lib/utils";
import type {
  WorkspaceDeliverySegmentId,
  WorkspaceHealthDashboard,
  WorkspaceHealthItem,
  WorkspaceHealthStatus,
} from "@/lib/quant/workspace-health";
import { OpsMetricCard, OpsSectionHeader } from "./OpsConsolePrimitives";

type HealthFilter = WorkspaceHealthStatus | "all";
type SegmentFilter = WorkspaceDeliverySegmentId | "active" | "all";

const PAGE_SIZE = 12;

const HEALTH_LABEL: Record<WorkspaceHealthStatus, string> = {
  healthy: "健康",
  warning: "风险",
  failed: "失败",
  unknown: "待验证",
};

function healthClass(status: WorkspaceHealthStatus) {
  if (status === "healthy") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-500";
  if (status === "warning") return "border-amber-500/25 bg-amber-500/10 text-amber-500";
  if (status === "failed") return "border-red-500/25 bg-red-500/10 text-red-500";
  return "border-border bg-muted text-muted-foreground";
}

function segmentClass(segment: WorkspaceDeliverySegmentId) {
  if (segment === "showcase") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-500";
  if (segment === "needs_repair") return "border-red-500/25 bg-red-500/10 text-red-500";
  if (segment === "archive_candidate") return "border-border bg-muted text-muted-foreground";
  return "border-amber-500/25 bg-amber-500/10 text-amber-500";
}

function WorkspaceCard({ project, onOpen }: { project: WorkspaceHealthItem; onOpen: () => void }) {
  const presentArtifacts = project.artifacts.filter((artifact) => artifact.exists).length;
  const scoreTone = project.health.score >= 80 ? "text-emerald-500" : project.health.score >= 60 ? "text-amber-500" : "text-red-500";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-[260px] flex-col rounded-xl border border-border/60 bg-card/90 p-5 text-left shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)] transition-all hover:-translate-y-0.5 hover:border-primary/35"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={cn("hover:bg-inherit", healthClass(project.health.status))}>{HEALTH_LABEL[project.health.status]}</Badge>
            <Badge className={cn("hover:bg-inherit", segmentClass(project.deliverySegment.id))}>{project.deliverySegment.label}</Badge>
          </div>
          <h3 className="mt-3 line-clamp-1 text-base font-bold text-foreground group-hover:text-primary">{project.name}</h3>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{project.id}</p>
        </div>
        <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-4 border-muted text-sm font-black tabular-nums", scoreTone)}>
          {project.health.score}
        </div>
      </div>
      <p className="mt-4 line-clamp-2 text-sm leading-6 text-muted-foreground">{project.health.summary}</p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-muted/45 px-2 py-2">
          <p className="text-[10px] text-muted-foreground">验证</p>
          <p className={cn("mt-1 text-xs font-semibold", project.validation.passed === true ? "text-emerald-500" : project.validation.passed === false ? "text-red-500" : "text-muted-foreground")}>
            {project.validation.passed === null ? "待执行" : project.validation.passed ? "通过" : "失败"}
          </p>
        </div>
        <div className="rounded-lg bg-muted/45 px-2 py-2">
          <p className="text-[10px] text-muted-foreground">关键产物</p>
          <p className="mt-1 text-xs font-semibold text-foreground">{presentArtifacts}/{project.artifacts.length}</p>
        </div>
        <div className="rounded-lg bg-muted/45 px-2 py-2">
          <p className="text-[10px] text-muted-foreground">阻断 / 警告</p>
          <p className="mt-1 text-xs font-semibold text-foreground">{project.health.blockers} / {project.health.warnings}</p>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border/40 pt-4 text-xs">
        <span className="truncate text-muted-foreground">{formatDate(project.lastActiveAt ?? project.updatedAt)}</span>
        <span className="inline-flex items-center gap-1 font-semibold text-primary">查看治理详情 <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
      </div>
    </button>
  );
}

function WorkspaceDetail({
  project,
  open,
  onOpenChange,
  validating,
  onValidate,
}: {
  project: WorkspaceHealthItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  validating: boolean;
  onValidate: (id: string) => void;
}) {
  if (!project) return null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[min(680px,calc(100vw-16px))] max-w-none flex-col gap-0 overflow-hidden border-l border-border bg-background p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border/50 bg-card/80 px-5 py-5 text-left">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-lg">{project.name}</SheetTitle>
                <Badge className={cn("hover:bg-inherit", healthClass(project.health.status))}>{HEALTH_LABEL[project.health.status]} · {project.health.score}</Badge>
                <Badge className={cn("hover:bg-inherit", segmentClass(project.deliverySegment.id))}>{project.deliverySegment.label}</Badge>
              </div>
              <SheetDescription className="mt-1 break-all font-mono text-xs">{project.repoPath}</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section className="rounded-xl border border-primary/20 bg-primary/5 p-4">
            <p className="text-sm font-semibold text-foreground">{project.health.summary}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">交付分层：{project.deliverySegment.reason}</p>
          </section>

          <div className="grid grid-cols-3 gap-2">
            {[
              ["验证", project.validation.passed === null ? "待执行" : project.validation.passed ? "通过" : "失败", project.validation.status],
              ["产物契约", HEALTH_LABEL[project.artifactContracts.status], project.artifactContracts.status],
              ["视觉验收", HEALTH_LABEL[project.visualValidation.status], project.visualValidation.status],
            ].map(([label, value, status]) => (
              <div key={label} className="rounded-lg border border-border/60 bg-card p-3 text-center">
                <p className="text-[10px] text-muted-foreground">{label}</p>
                <p className={cn("mt-1 text-sm font-bold", healthClass(status as WorkspaceHealthStatus).split(" ").at(-1))}>{value}</p>
              </div>
            ))}
          </div>

          {project.nextActions.length > 0 && (
            <section>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Sparkles className="h-4 w-4 text-primary" />建议操作</h3>
              <div className="mt-3 space-y-2">
                {project.nextActions.map((action) => <div key={action} className="rounded-lg border border-primary/15 bg-primary/5 px-3 py-2.5 text-sm leading-6 text-foreground">{action}</div>)}
              </div>
            </section>
          )}

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><FileText className="h-4 w-4 text-primary" />交付产物</h3>
            <div className="mt-3 divide-y divide-border/40 overflow-hidden rounded-xl border border-border/60 bg-card">
              {project.artifacts.map((artifact) => (
                <div key={artifact.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{artifact.label}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{artifact.path}</p>
                  </div>
                  <Badge className={cn("hover:bg-inherit", healthClass(artifact.status))}>{artifact.exists ? HEALTH_LABEL[artifact.status] : "缺失"}</Badge>
                </div>
              ))}
            </div>
          </section>

          {project.events.length > 0 && (
            <section>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Clock3 className="h-4 w-4 text-primary" />最近事件</h3>
              <div className="mt-3 space-y-2">
                {project.events.slice(-6).reverse().map((event, index) => (
                  <div key={`${event.created_at}-${index}`} className="rounded-lg border border-border/60 bg-card px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium text-foreground">{event.stage}</p><span className="text-[11px] text-muted-foreground">{formatDate(event.created_at ?? null)}</span></div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{event.summary}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {project.repairPlan.needed && (
            <section className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-500"><Wrench className="h-4 w-4" />待执行修复计划</h3>
              <p className="mt-2 break-all text-xs leading-5 text-muted-foreground">{project.repairPlan.stepCount} 个步骤 · {project.repairPlan.path}</p>
            </section>
          )}
        </div>
        <div className="grid gap-2 border-t border-border/50 bg-card/80 p-4 sm:grid-cols-2">
          <Button onClick={() => onValidate(project.id)} disabled={validating}>
            {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />}重新验证
          </Button>
          <Button variant="outline" asChild><Link href={`/${project.id}/chat`}>打开项目会话 <ArrowRight className="h-4 w-4" /></Link></Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function OpsWorkspacesView({
  data,
  validatingId,
  onValidate,
}: {
  data: WorkspaceHealthDashboard;
  validatingId: string | null;
  onValidate: (id: string) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [segmentFilter, setSegmentFilter] = useState<SegmentFilter>("active");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<WorkspaceHealthItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    return data.projects.filter((project) => {
      if (healthFilter !== "all" && project.health.status !== healthFilter) return false;
      if (segmentFilter === "active" && project.deliverySegment.id === "archive_candidate") return false;
      if (segmentFilter !== "all" && segmentFilter !== "active" && project.deliverySegment.id !== segmentFilter) return false;
      if (!lower) return true;
      return [project.id, project.name, project.description, project.repoPath, project.quantCapabilityId, ...project.runPlan.symbols]
        .filter(Boolean).join(" ").toLowerCase().includes(lower);
    });
  }, [data.projects, healthFilter, keyword, segmentFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const projects = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const delivery = data.delivery ?? {
    showcase: data.summary.healthy,
    atRisk: data.summary.warning + data.summary.unknown,
    needsRepair: data.summary.failed,
    archiveCandidates: 0,
    activeTotal: data.summary.total,
    activeAverageScore: data.summary.averageScore,
  };

  const openProject = (project: WorkspaceHealthItem) => {
    setSelected(project);
    setDetailOpen(true);
  };

  return (
    <div className="space-y-7">
      <OpsSectionHeader eyebrow="WORKSPACE FLEET" title="工作空间交付治理" description="按可演示、风险、待修复和归档候选分层，历史失败不会继续污染当前平台可用性。" />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OpsMetricCard icon={<Gauge className="h-4 w-4" />} label="活跃交付分" value={delivery.activeAverageScore} helper={`${delivery.activeTotal} 个活跃工作空间`} tone={delivery.activeAverageScore >= 80 ? "emerald" : "amber"} />
        <OpsMetricCard icon={<CheckCircle2 className="h-4 w-4" />} label="可直接演示" value={delivery.showcase} helper="验证与交付契约均可用" tone="emerald" />
        <OpsMetricCard icon={<ShieldAlert className="h-4 w-4" />} label="待处理" value={delivery.atRisk + delivery.needsRepair} helper={`${delivery.needsRepair} 个需要优先修复`} tone={delivery.needsRepair ? "red" : "amber"} />
        <OpsMetricCard icon={<Archive className="h-4 w-4" />} label="归档候选" value={delivery.archiveCandidates} helper="与活跃交付评分隔离" tone="slate" />
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} placeholder="搜索项目、能力、标的或工作空间路径" className="h-10 bg-card pl-9" aria-label="搜索工作空间" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["all", "failed", "warning", "unknown", "healthy"] as HealthFilter[]).map((status) => (
              <button key={status} type="button" onClick={() => { setHealthFilter(status); setPage(1); }} className={cn("rounded-lg border px-3 py-2 text-xs font-semibold transition-colors", healthFilter === status ? "border-primary/30 bg-primary/10 text-primary" : "border-border/60 bg-card text-muted-foreground hover:text-foreground")}>
                {status === "all" ? "全部状态" : HEALTH_LABEL[status]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">交付分层</span>
          {(["active", "showcase", "at_risk", "needs_repair", "archive_candidate", "all"] as SegmentFilter[]).map((segment) => {
            const labels: Record<SegmentFilter, string> = { active: "活跃项目", showcase: "可演示", at_risk: "有风险", needs_repair: "待修复", archive_candidate: "归档候选", all: "全部" };
            return <button key={segment} type="button" onClick={() => { setSegmentFilter(segment); setPage(1); }} className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", segmentFilter === segment ? "border-primary/30 bg-primary/10 text-primary" : "border-border/60 bg-card text-muted-foreground")}>{labels[segment]}</button>;
          })}
          <span className="ml-auto text-xs text-muted-foreground">显示 {filtered.length}/{data.projects.length}</span>
        </div>
      </section>

      {projects.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => <WorkspaceCard key={project.id} project={project} onOpen={() => openProject(project)} />)}
        </div>
      ) : (
        <EmptyState icon={<Boxes className="h-5 w-5" />} title="没有匹配的工作空间" description="调整状态、交付分层或搜索条件后再试。" className="rounded-xl border border-border/60 bg-card py-16" />
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card px-4 py-3 text-sm text-muted-foreground">
          <span>第 {safePage}/{pageCount} 页 · 共 {filtered.length} 个</span>
          <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage === 1}>上一页</Button><Button variant="outline" size="sm" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={safePage === pageCount}>下一页</Button></div>
        </div>
      )}

      <WorkspaceDetail project={selected} open={detailOpen} onOpenChange={setDetailOpen} validating={validatingId === selected?.id} onValidate={onValidate} />
    </div>
  );
}
