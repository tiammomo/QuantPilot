"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircleAlert,
  CloudCog,
  Code2,
  Command,
  Database,
  ExternalLink,
  Gauge,
  GitBranch,
  HardDrive,
  Network,
  RefreshCcw,
  ScrollText,
  Search,
  ServerCog,
  Sparkles,
  Wrench,
} from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { SubNav, subNavPanelId, subNavTabId, type SubNavItem } from "@/components/layout/SubNav";
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
import type { WorkspaceHealthDashboard, WorkspaceHealthItem } from "@/lib/quant/workspace-health";
import type { GenerationObservabilityDashboard } from "@/lib/quant/generation-observability";
import type { OpsCheck, OpsCheckStatus, OpsPlatformDashboard } from "@/lib/ops/ops-platform";
import type { ResolvedServiceCatalogEntry } from "@/lib/platform/service-catalog";
import {
  OPS_STATUS_LABEL,
  OpsMetricCard,
  OpsProgress,
  OpsSectionHeader,
  OpsStatusBadge,
  OpsStatusIcon,
} from "./OpsConsolePrimitives";
import { OpsWorkspacesView } from "./OpsWorkspacesView";
import { OpsTraceView } from "./OpsTraceView";
import { OpsLogsView } from "./OpsLogsView";

export type OpsView = "overview" | "services" | "workspaces" | "trace" | "logs";

type Props = {
  initialData: WorkspaceHealthDashboard;
  initialTraceData: GenerationObservabilityDashboard | null;
  initialOpsData: OpsPlatformDashboard;
  initialView?: OpsView;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

const EMPTY_TRACE_DATA: GenerationObservabilityDashboard = {
  generatedAt: "1970-01-01T00:00:00.000Z",
  projectsDir: "",
  summary: {
    total: 0,
    healthy: 0,
    warning: 0,
    failed: 0,
    running: 0,
    unknown: 0,
    eventsLast24h: 0,
    toolCalls: 0,
    requests: 0,
  },
  projects: [],
};

const VIEW_ITEMS: SubNavItem[] = [
  { id: "overview", label: "运行总览", icon: <Gauge className="h-4 w-4" /> },
  { id: "services", label: "服务治理", icon: <Network className="h-4 w-4" /> },
  { id: "workspaces", label: "工作空间", icon: <Boxes className="h-4 w-4" /> },
  { id: "trace", label: "生成链路", icon: <GitBranch className="h-4 w-4" /> },
  { id: "logs", label: "运行日志", icon: <ScrollText className="h-4 w-4" /> },
];

function isOpsView(value: string | null): value is OpsView {
  return VIEW_ITEMS.some((item) => item.id === value);
}

function configurationStatus(service: ResolvedServiceCatalogEntry): OpsCheckStatus {
  if (!service.enabled || service.configurationStatus === "disabled") return "unknown";
  return service.configurationStatus;
}

function requirementLabel(service: ResolvedServiceCatalogEntry) {
  if (!service.enabled) return "已停用";
  return service.required ? "核心依赖" : "可降级";
}

function profileIcon(id: string) {
  if (id === "project") return <Boxes className="h-5 w-5" />;
  if (id === "strategy") return <Sparkles className="h-5 w-5" />;
  return <CloudCog className="h-5 w-5" />;
}

function RiskItem({ check }: { check: OpsCheck }) {
  return (
    <article className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted"><OpsStatusIcon status={check.status} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-bold text-foreground">{check.label}</h3><OpsStatusBadge status={check.status} /></div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{check.summary}</p>
          {check.detail && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{check.detail}</p>}
          {check.actions?.length ? <div className="mt-3 space-y-1.5">{check.actions.map((action) => <p key={action} className="flex items-start gap-2 text-xs text-foreground"><Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />{action}</p>)}</div> : null}
        </div>
      </div>
    </article>
  );
}

function ProfileCard({ profile }: { profile: OpsPlatformDashboard["healthProfiles"][number] }) {
  return (
    <article className="rounded-xl border border-border/60 bg-card/90 p-5 shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">{profileIcon(profile.id)}</span>
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-bold text-foreground">{profile.label}</h3><OpsStatusBadge status={profile.status} /></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{profile.summary}</p></div>
        </div>
        <p className="text-2xl font-black tabular-nums text-foreground">{profile.score}</p>
      </div>
      <div className="mt-5 space-y-4">
        {profile.factors.map((factor) => (
          <div key={factor.id}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="truncate font-medium text-foreground">{factor.label} <span className="text-muted-foreground">· {factor.weight}%</span></span><span className="font-mono font-bold text-foreground">{factor.score}</span></div>
            <OpsProgress value={factor.score} status={factor.status} />
            <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{factor.summary}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function WorkspaceSignal({ project, onOpenWorkspaces }: { project: WorkspaceHealthItem; onOpenWorkspaces: () => void }) {
  return (
    <button type="button" onClick={onOpenWorkspaces} className="group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/50">
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-4 border-muted text-xs font-black tabular-nums", project.health.score >= 80 ? "text-emerald-500" : project.health.score >= 60 ? "text-amber-500" : "text-red-500")}>{project.health.score}</span>
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-foreground">{project.name}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{project.deliverySegment.label} · {project.health.summary}</p></div>
      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </button>
  );
}

function OverviewView({
  ops,
  health,
  trace,
  onViewChange,
}: {
  ops: OpsPlatformDashboard;
  health: WorkspaceHealthDashboard;
  trace: GenerationObservabilityDashboard;
  onViewChange: (view: OpsView) => void;
}) {
  const delivery = health.delivery ?? { showcase: health.summary.healthy, atRisk: health.summary.warning + health.summary.unknown, needsRepair: health.summary.failed, archiveCandidates: 0, activeTotal: health.summary.total, activeAverageScore: health.summary.averageScore };
  const checks = [...ops.systemChecks, ...ops.capabilityChecks];
  const attention = checks.filter((check) => check.status === "failed" || check.status === "warning");
  const blocking = attention.filter((check) => check.status === "failed").length;
  const readableLogs = ops.logSources.filter((source) => source.exists).length;
  const activeEdges = ops.serviceDependencyEdges.filter((edge) => edge.active).length;
  const workspaceSignals = [...health.projects].filter((project) => project.deliverySegment.id !== "archive_candidate").sort((a, b) => a.health.score - b.health.score).slice(0, 4);
  const posture = blocking > 0 ? "存在阻断" : attention.length > 0 ? "可运行，需关注" : "运行稳定";

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.16),transparent_40%),linear-gradient(135deg,hsl(var(--card)),hsl(var(--muted)/0.5))] p-5 shadow-[0_30px_70px_-52px_hsl(var(--primary)/0.5)] sm:p-7">
        <div className="absolute -right-12 -top-16 h-48 w-48 rounded-full border border-primary/15" />
        <div className="relative flex flex-col gap-7 xl:flex-row xl:items-center xl:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">OPERATIONS COMMAND</Badge><OpsStatusBadge status={ops.summary.status} label={posture} /></div>
            <h2 className="mt-4 text-2xl font-black tracking-tight text-foreground sm:text-3xl">系统当前可以运行，风险边界清晰可见</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">统一判断核心服务、工作空间交付、策略准备度与生成链路。先处理阻断，再处理降级和历史工作空间，不让噪声掩盖真正故障。</p>
            <div className="mt-5 flex flex-wrap gap-2"><Button onClick={() => onViewChange(attention.length ? "services" : "workspaces")}>{attention.length ? "处理运行风险" : "查看工作空间"}<ArrowRight className="h-4 w-4" /></Button><Button variant="outline" onClick={() => onViewChange("trace")}>查看生成链路</Button></div>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3 xl:min-w-[460px]">
            <div className="rounded-xl border border-border/60 bg-background/70 p-4 backdrop-blur"><p className="text-xs text-muted-foreground">综合健康</p><p className="mt-2 text-4xl font-black tabular-nums text-foreground">{ops.summary.score}</p><p className="mt-1 text-[11px] text-muted-foreground">{ops.summary.ok} 项正常</p></div>
            <div className="rounded-xl border border-border/60 bg-background/70 p-4 backdrop-blur"><p className="text-xs text-muted-foreground">当前风险</p><p className={cn("mt-2 text-4xl font-black tabular-nums", blocking ? "text-red-500" : attention.length ? "text-amber-500" : "text-emerald-500")}>{attention.length}</p><p className="mt-1 text-[11px] text-muted-foreground">{blocking} 阻断 · {attention.length - blocking} 关注</p></div>
            <div className="rounded-xl border border-border/60 bg-background/70 p-4 backdrop-blur"><p className="text-xs text-muted-foreground">活跃交付分</p><p className="mt-2 text-4xl font-black tabular-nums text-foreground">{delivery.activeAverageScore}</p><p className="mt-1 text-[11px] text-muted-foreground">{delivery.activeTotal} 个项目</p></div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OpsMetricCard icon={<ServerCog className="h-4 w-4" />} label="启用服务" value={`${ops.serviceCatalogValidation.enabledCount}/${ops.serviceCatalogValidation.serviceCount}`} helper={`${ops.serviceCatalogValidation.requiredCount} 个核心依赖 · ${activeEdges} 条活动依赖`} tone={ops.serviceCatalogValidation.ok ? "emerald" : "red"} />
        <OpsMetricCard icon={<Boxes className="h-4 w-4" />} label="待处理工作空间" value={delivery.atRisk + delivery.needsRepair} helper={`${delivery.showcase} 个可直接演示 · ${delivery.archiveCandidates} 个归档候选`} tone={delivery.needsRepair ? "red" : delivery.atRisk ? "amber" : "emerald"} />
        <OpsMetricCard icon={<GitBranch className="h-4 w-4" />} label="链路阻断" value={trace.summary.failed} helper={`${trace.summary.running} 个运行中 · 24h ${trace.summary.eventsLast24h} 个事件`} tone={trace.summary.failed ? "red" : "blue"} />
        <OpsMetricCard icon={<ScrollText className="h-4 w-4" />} label="可读日志源" value={`${readableLogs}/${ops.logSources.length}`} helper="Loki 不可用时自动使用本地文件" tone={readableLogs ? "emerald" : "red"} />
      </section>

      <section className="space-y-4">
        <OpsSectionHeader eyebrow="HEALTH MODEL" title="三层健康模型" description="项目交付、运行底座和策略研究分别计分，避免某一层的历史问题把整个系统误判为不可用。" />
        <div className="grid gap-4 xl:grid-cols-3">{ops.healthProfiles.map((profile) => <ProfileCard key={profile.id} profile={profile} />)}</div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <div className="space-y-4">
          <OpsSectionHeader eyebrow="ATTENTION QUEUE" title="需要关注的运行项" description="仅展示 warning 与 failed，并直接给出下一步动作。" action={<Button variant="outline" size="sm" onClick={() => onViewChange("services")}>完整巡检 <ArrowRight className="h-3.5 w-3.5" /></Button>} />
          {attention.length ? <div className="grid gap-3 md:grid-cols-2">{attention.slice(0, 6).map((check) => <RiskItem key={check.id} check={check} />)}</div> : <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-6"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-500" /><div><h3 className="font-bold text-foreground">没有待处理的运行项</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">所有核心巡检均正常，可继续关注工作空间交付和生成链路。</p></div></div></div>}
        </div>
        <div className="space-y-4">
          <OpsSectionHeader eyebrow="DELIVERY SIGNALS" title="工作空间信号" description="优先展示活跃工作空间中评分最低的项目。" />
          <div className="overflow-hidden rounded-xl border border-border/60 bg-card p-2 shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)]">
            {workspaceSignals.length ? workspaceSignals.map((project) => <WorkspaceSignal key={project.id} project={project} onOpenWorkspaces={() => onViewChange("workspaces")} />) : <EmptyState title="暂无活跃工作空间" description="从首页创建任务后，这里会显示交付信号。" className="border-0 py-12" />}
          </div>
        </div>
      </section>
    </div>
  );
}

function ServiceCard({ service, onOpen }: { service: ResolvedServiceCatalogEntry; onOpen: () => void }) {
  const status = configurationStatus(service);
  return (
    <button type="button" onClick={onOpen} className="group flex min-h-[250px] flex-col rounded-xl border border-border/60 bg-card/90 p-5 text-left shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)] transition-all hover:-translate-y-0.5 hover:border-primary/35">
      <div className="flex items-start justify-between gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">{service.kind === "database" || service.kind === "analytics" ? <Database className="h-5 w-5" /> : service.kind === "observability" ? <Activity className="h-5 w-5" /> : <ServerCog className="h-5 w-5" />}</span><OpsStatusBadge status={status} label={!service.enabled ? "已停用" : status === "ok" ? "配置正常" : OPS_STATUS_LABEL[status]} /></div>
      <div className="mt-4 flex flex-wrap items-center gap-2"><h3 className="text-base font-bold text-foreground group-hover:text-primary">{service.name}</h3><Badge variant="outline" className="text-[10px] text-muted-foreground">{requirementLabel(service)}</Badge></div>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{service.summary}</p>
      <div className="mt-4 flex flex-wrap gap-1.5"><Badge variant="outline" className="bg-background/60 text-[10px] text-muted-foreground">{service.runtime}</Badge><Badge variant="outline" className="bg-background/60 text-[10px] text-muted-foreground">{service.domain}</Badge><Badge variant="outline" className="bg-background/60 text-[10px] text-muted-foreground">{service.owner}</Badge></div>
      <div className="mt-auto border-t border-border/40 pt-4"><p className="truncate font-mono text-[11px] text-muted-foreground">{service.endpoint ?? "endpoint 未配置"}</p><div className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span>{service.dependencies.length} 个上游依赖</span><span className="inline-flex items-center gap-1 font-semibold text-primary">查看契约 <ArrowRight className="h-3.5 w-3.5" /></span></div></div>
    </button>
  );
}

function ServiceDetail({ service, open, onOpenChange }: { service: ResolvedServiceCatalogEntry | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  if (!service) return null;
  const status = configurationStatus(service);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[min(680px,calc(100vw-16px))] max-w-none flex-col gap-0 overflow-hidden border-l border-border bg-background p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border/50 bg-card/80 px-5 py-5 text-left"><div className="flex items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><ServerCog className="h-5 w-5" /></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><SheetTitle className="text-lg">{service.name}</SheetTitle><OpsStatusBadge status={status} label={status === "ok" ? "配置正常" : OPS_STATUS_LABEL[status]} /></div><SheetDescription className="mt-1 leading-5">{service.summary}</SheetDescription></div></div></SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[["运行时", service.runtime], ["类型", service.kind], ["生命周期", service.lifecycle], ["依赖级别", requirementLabel(service)]].map(([label, value]) => <div key={label} className="rounded-lg border border-border/60 bg-card p-3"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-semibold text-foreground">{value}</p></div>)}</section>
          <section><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Network className="h-4 w-4 text-primary" />连接与依赖</h3><div className="mt-3 space-y-2 rounded-xl border border-border/60 bg-card p-4"><div><p className="text-[10px] text-muted-foreground">Endpoint</p><p className="mt-1 break-all font-mono text-xs text-foreground">{service.endpoint ?? "未配置"}</p></div><div><p className="text-[10px] text-muted-foreground">Health URL</p><p className="mt-1 break-all font-mono text-xs text-foreground">{service.healthUrl ?? "未登记"}</p></div><div><p className="text-[10px] text-muted-foreground">上游依赖</p><div className="mt-2 flex flex-wrap gap-1.5">{service.dependencies.length ? service.dependencies.map((dependency) => <Badge key={dependency} variant="outline">{dependency}</Badge>) : <span className="text-xs text-muted-foreground">无</span>}</div></div></div></section>
          <section><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Command className="h-4 w-4 text-primary" />运维命令</h3><div className="mt-3 space-y-2">{Object.entries(service.commands).map(([name, command]) => <div key={name} className="rounded-lg border border-border/60 bg-card px-3 py-3"><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{name}</p><code className="mt-1 block break-all text-xs text-foreground">{command}</code></div>)}</div></section>
          <section><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Code2 className="h-4 w-4 text-primary" />能力与归属</h3><div className="mt-3 rounded-xl border border-border/60 bg-card p-4"><p className="text-xs text-muted-foreground">{service.owner} · {service.domain}</p><div className="mt-3 flex flex-wrap gap-1.5">{service.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}</div></div></section>
          {service.issues.length > 0 && <section className="rounded-xl border border-red-500/20 bg-red-500/10 p-4"><h3 className="flex items-center gap-2 text-sm font-semibold text-red-500"><CircleAlert className="h-4 w-4" />配置问题</h3><div className="mt-2 space-y-1">{service.issues.map((issue) => <p key={issue} className="text-xs leading-5 text-foreground">• {issue}</p>)}</div></section>}
        </div>
        {service.endpointProtocol === "http" && service.endpoint && <div className="border-t border-border/50 bg-card/80 p-4"><Button variant="outline" asChild><a href={service.endpoint} target="_blank" rel="noreferrer">打开服务地址 <ExternalLink className="h-4 w-4" /></a></Button></div>}
      </SheetContent>
    </Sheet>
  );
}

function CheckGroup({ title, description, checks }: { title: string; description: string; checks: OpsCheck[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)]">
      <div className="border-b border-border/50 px-4 py-4"><h3 className="text-sm font-bold text-foreground">{title}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>
      <div className="divide-y divide-border/40">{checks.map((check) => <div key={check.id} className="px-4 py-4"><div className="flex flex-wrap items-center gap-2"><OpsStatusIcon status={check.status} /><p className="text-sm font-semibold text-foreground">{check.label}</p><OpsStatusBadge status={check.status} /></div><p className="mt-2 text-sm leading-6 text-muted-foreground">{check.summary}</p>{check.detail && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{check.detail}</p>}{check.actions?.map((action) => <p key={action} className="mt-2 flex items-start gap-2 text-xs text-primary"><Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0" />{action}</p>)}</div>)}</div>
    </section>
  );
}

function ServicesView({ data }: { data: OpsPlatformDashboard }) {
  const [keyword, setKeyword] = useState("");
  const [runtime, setRuntime] = useState("all");
  const [selected, setSelected] = useState<ResolvedServiceCatalogEntry | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const runtimes = ["all", ...Array.from(new Set(data.serviceCatalog.map((service) => service.runtime)))];
  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    return data.serviceCatalog.filter((service) => {
      if (runtime !== "all" && service.runtime !== runtime) return false;
      if (!lower) return true;
      return [service.id, service.name, service.summary, service.runtime, service.kind, service.domain, service.owner, service.endpoint, ...service.capabilities].filter(Boolean).join(" ").toLowerCase().includes(lower);
    });
  }, [data.serviceCatalog, keyword, runtime]);
  const infrastructure = data.infrastructure;
  return (
    <div className="space-y-8">
      <OpsSectionHeader eyebrow="SERVICE GOVERNANCE" title="服务目录与运行底座" description="统一维护服务边界、依赖级别、端点、启动命令与降级契约；配置状态和真实运行探测分开表达。" />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OpsMetricCard icon={<Network className="h-4 w-4" />} label="服务目录" value={`${data.serviceCatalogValidation.enabledCount}/${data.serviceCatalogValidation.serviceCount}`} helper={`${data.serviceCatalogValidation.requiredCount} 个核心依赖`} tone={data.serviceCatalogValidation.ok ? "emerald" : "red"} />
        <OpsMetricCard icon={<Database className="h-4 w-4" />} label="事实数据库" value={infrastructure.connected ? "已连接" : "未连接"} helper={infrastructure.timescale.enabled ? `TimescaleDB ${infrastructure.timescale.version}` : "TimescaleDB 未启用"} tone={infrastructure.connected ? "emerald" : "red"} />
        <OpsMetricCard icon={<HardDrive className="h-4 w-4" />} label="量化表" value={infrastructure.quantSchema.tables.length} helper="quant schema 可用表" tone={infrastructure.quantSchema.tables.length >= 4 ? "blue" : "amber"} />
        <OpsMetricCard icon={<ServerCog className="h-4 w-4" />} label="数据库容器" value={infrastructure.docker.running ? "运行中" : "未运行"} helper={infrastructure.docker.service?.status ?? infrastructure.docker.error ?? "未发现容器"} tone={infrastructure.docker.running ? "emerald" : "amber"} />
      </section>

      {data.infrastructureError && <div role="alert" className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">{data.infrastructureError}</div>}

      <section className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索服务、运行时、能力或端点" className="h-10 bg-card pl-9" aria-label="搜索服务" /></div><div className="flex flex-wrap gap-1.5">{runtimes.map((item) => <button key={item} type="button" onClick={() => setRuntime(item)} className={cn("rounded-lg border px-3 py-2 text-xs font-semibold", runtime === item ? "border-primary/30 bg-primary/10 text-primary" : "border-border/60 bg-card text-muted-foreground")}>{item === "all" ? "全部运行时" : item}</button>)}</div></div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{filtered.map((service) => <ServiceCard key={service.id} service={service} onOpen={() => { setSelected(service); setDetailOpen(true); }} />)}</div>
        {!filtered.length && <EmptyState title="没有匹配的服务" description="调整搜索关键词或运行时筛选。" className="rounded-xl border border-border/60 bg-card py-14" />}
      </section>

      <section className="space-y-4">
        <OpsSectionHeader eyebrow="DEPENDENCY GRAPH" title="活动依赖关系" description="展示当前启用服务之间的真实依赖，停用服务的边不会被计入运行风险。" action={<OpsStatusBadge status={data.serviceCatalogValidation.ok ? "ok" : "failed"} label={`${data.serviceDependencyEdges.filter((edge) => edge.active).length}/${data.serviceDependencyEdges.length} 条活动依赖`} />} />
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{data.serviceDependencyEdges.map((edge) => <div key={`${edge.from}-${edge.to}`} className={cn("flex items-center gap-3 rounded-xl border px-4 py-3", edge.active ? "border-border/60 bg-card" : "border-border/40 bg-muted/30 opacity-60")}><span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{edge.fromName}</span><ArrowRight className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-right text-sm font-semibold text-foreground">{edge.toName}</span></div>)}</div>
      </section>

      <section className="grid gap-5 xl:grid-cols-2"><CheckGroup title="基础环境巡检" description="运行时、工具链、存储、数据库与外部服务探测。" checks={data.systemChecks} /><CheckGroup title="平台能力巡检" description="能力目录、Skills、数据源、量化表与日志入口。" checks={data.capabilityChecks} /></section>

      <section className="rounded-xl border border-border/60 bg-card p-5"><h3 className="flex items-center gap-2 text-sm font-bold text-foreground"><Command className="h-4 w-4 text-primary" />数据库常用命令</h3><div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{Object.entries(infrastructure.commands).map(([name, command]) => <div key={name} className="rounded-lg border border-border/60 bg-background/60 px-3 py-3"><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{name}</p><code className="mt-1 block break-all text-xs text-foreground">{command}</code></div>)}</div></section>
      <ServiceDetail service={selected} open={detailOpen} onOpenChange={setDetailOpen} />
    </div>
  );
}

export default function OpsPlatformClient({ initialData, initialTraceData, initialOpsData, initialView = "overview" }: Props) {
  const [view, setView] = useState<OpsView>(initialView);
  const [healthData, setHealthData] = useState(initialData);
  const [traceData, setTraceData] = useState(initialTraceData ?? EMPTY_TRACE_DATA);
  const [opsData, setOpsData] = useState(initialOpsData);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [traceSummaryLoaded, setTraceSummaryLoaded] = useState(Boolean(initialTraceData));
  const [traceDetailLoaded, setTraceDetailLoaded] = useState(initialView === "trace" && Boolean(initialTraceData));
  const [logsLoaded, setLogsLoaded] = useState(initialView === "logs");
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const updateUrl = useCallback((nextView: OpsView) => {
    const url = new URL(window.location.href);
    if (nextView === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", nextView);
    window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const changeView = useCallback((nextView: OpsView) => {
    setView(nextView);
    updateUrl(nextView);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [updateUrl]);

  useEffect(() => {
    const applyLocation = () => {
      const requested = new URL(window.location.href).searchParams.get("view");
      if (isOpsView(requested)) setView(requested);
      else if (requested === "health") setView("workspaces");
      else if (requested === "system" || requested === "docker") setView("services");
      else setView("overview");
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, []);

  useEffect(() => {
    const needsTraceDetails = view === "trace" && !traceDetailLoaded;
    const needsTraceSummary = view === "overview" && !traceSummaryLoaded;
    if (!needsTraceDetails && !needsTraceSummary) return;
    let cancelled = false;
    setIsLoadingTrace(true);
    fetch(`${API_BASE}/api/workspaces/trace${needsTraceDetails ? "?events=120" : "?summary=1"}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error ?? "加载生成链路失败");
        if (cancelled) return;
        setTraceData(payload.data);
        setTraceSummaryLoaded(true);
        if (needsTraceDetails) setTraceDetailLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) setFeedback({ type: "error", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTrace(false);
      });
    return () => { cancelled = true; };
  }, [traceDetailLoaded, traceSummaryLoaded, view]);

  useEffect(() => {
    if (view !== "logs" || logsLoaded) return;
    let cancelled = false;
    setIsLoadingLogs(true);
    fetch(`${API_BASE}/api/ops/platform?includeLogs=1`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error ?? "加载运行日志失败");
        if (cancelled) return;
        setOpsData(payload.data);
        setLogsLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) setFeedback({ type: "error", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) setIsLoadingLogs(false);
      });
    return () => { cancelled = true; };
  }, [logsLoaded, view]);

  const refresh = async () => {
    setIsRefreshing(true);
    setFeedback(null);
    try {
      const [healthResponse, traceResponse, opsResponse] = await Promise.all([
        fetch(`${API_BASE}/api/workspaces/health`, { cache: "no-store" }),
        fetch(`${API_BASE}/api/workspaces/trace${view === "trace" ? "?events=120" : "?summary=1"}`, { cache: "no-store" }),
        fetch(`${API_BASE}/api/ops/platform${view === "logs" ? "?includeLogs=1" : ""}`, { cache: "no-store" }),
      ]);
      const [healthPayload, tracePayload, opsPayload] = await Promise.all([healthResponse.json(), traceResponse.json(), opsResponse.json()]);
      if (!healthResponse.ok || !healthPayload.success) throw new Error(healthPayload.error ?? "刷新工作空间失败");
      if (!traceResponse.ok || !tracePayload.success) throw new Error(tracePayload.error ?? "刷新生成链路失败");
      if (!opsResponse.ok || !opsPayload.success) throw new Error(opsPayload.error ?? "刷新运行状态失败");
      setHealthData(healthPayload.data);
      setTraceData(tracePayload.data);
      setOpsData(opsPayload.data);
      setTraceSummaryLoaded(true);
      setTraceDetailLoaded(view === "trace");
      setLogsLoaded(view === "logs");
      setFeedback({ type: "success", message: "运行状态已刷新" });
    } catch (error) {
      setFeedback({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRefreshing(false);
    }
  };

  const validateProject = async (projectId: string) => {
    setValidatingId(projectId);
    setFeedback(null);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/quant/validation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: `ops-console-${Date.now()}` }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message ?? "验证失败");
      setFeedback({ type: payload.data?.passed ? "success" : "error", message: payload.data?.passed ? "工作空间验证通过" : "验证未通过，修复计划已更新" });
      await refresh();
    } catch (error) {
      setFeedback({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setValidatingId(null);
    }
  };

  const generatedAt = view === "trace" && traceSummaryLoaded ? traceData.generatedAt : view === "workspaces" ? healthData.generatedAt : opsData.generatedAt;
  return (
    <div className="platform-shell">
      <PageHeader title="运行治理中心" badge={<Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">综合健康 {opsData.summary.score}</Badge>} subtitle={`服务、交付、链路与日志统一治理 · 更新于 ${formatDate(generatedAt)}`} />
      <SubNav ariaLabel="运行治理视图" items={VIEW_ITEMS} activeId={view} onChange={(id) => changeView(id as OpsView)} actions={<Button aria-label="刷新运行状态" title="刷新运行状态" variant="outline" size="sm" onClick={refresh} disabled={isRefreshing} className="gap-1.5"><RefreshCcw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} /><span className="hidden sm:inline">刷新运行状态</span></Button>} />
      <main id={subNavPanelId(view)} role="tabpanel" aria-labelledby={subNavTabId(view)} tabIndex={0} className="platform-content mx-auto max-w-[1520px] space-y-6 px-3 py-5 sm:px-6 sm:py-7 lg:px-8">
        {feedback && <div role="status" className={cn("rounded-xl border px-4 py-3 text-sm", feedback.type === "success" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-500" : "border-red-500/25 bg-red-500/10 text-red-500")}>{feedback.message}</div>}
        {view === "overview" && <OverviewView ops={opsData} health={healthData} trace={traceData} onViewChange={changeView} />}
        {view === "services" && <ServicesView data={opsData} />}
        {view === "workspaces" && <OpsWorkspacesView data={healthData} validatingId={validatingId} onValidate={validateProject} />}
        {view === "trace" && (isLoadingTrace && !traceDetailLoaded
          ? <EmptyState title="正在加载生成链路" description="按需读取完整事件、验证与修复记录…" className="rounded-xl border border-border/60 bg-card py-14" />
          : <OpsTraceView data={traceData} />)}
        {view === "logs" && (isLoadingLogs && !logsLoaded
          ? <EmptyState title="正在加载运行日志" description="按需读取并解析最近的日志现场…" className="rounded-xl border border-border/60 bg-card py-14" />
          : <OpsLogsView data={opsData} />)}
      </main>
    </div>
  );
}
