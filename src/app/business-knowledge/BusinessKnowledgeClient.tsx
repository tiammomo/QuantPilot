"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  Boxes,
  BriefcaseBusiness,
  CheckCircle2,
  CircleAlert,
  Compass,
  Database,
  FileCheck2,
  Layers3,
  LibraryBig,
  LineChart,
  RefreshCcw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Workflow,
  Zap,
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
import type {
  CapabilityCenterData,
  CapabilityCenterDataProvider,
  CapabilityCenterItem,
} from "@/lib/quant/capability-center";
import { cn } from "@/lib/utils";

type Props = { initialData: CapabilityCenterData };
type ViewId = "overview" | "capabilities" | "knowledge" | "resources";
type StatusFilter = "all" | "ready" | "planned" | "attention";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

const VIEW_ITEMS: SubNavItem[] = [
  { id: "overview", label: "业务总览", icon: <Compass className="h-4 w-4" /> },
  { id: "capabilities", label: "能力目录", icon: <BriefcaseBusiness className="h-4 w-4" /> },
  { id: "knowledge", label: "业务知识", icon: <BookOpenCheck className="h-4 w-4" /> },
  { id: "resources", label: "支撑资源", icon: <Workflow className="h-4 w-4" /> },
];

const CAPABILITY_ICONS: Record<string, typeof Activity> = {
  stock_diagnosis: Activity,
  technical_analysis: TrendingUp,
  fundamental_analysis: BarChart3,
  asset_comparison: Boxes,
  sector_rotation: LineChart,
  strategy_research: Sparkles,
  backtest_review: Target,
  portfolio_risk: ShieldCheck,
};

const GROUP_ICONS: Record<string, typeof Activity> = {
  core_analysis: Activity,
  market_research: LineChart,
  strategy_risk: ShieldCheck,
};

const CATEGORY_LABELS: Record<string, string> = {
  "market-data": "行情与价格",
  symbol: "标的识别",
  indicator: "指标计算",
  backtest: "回测引擎",
  fundamental: "基本面数据",
  event: "公告与事件",
  "index-etf": "指数与 ETF",
  ingestion: "数据采集",
  "research-config": "研究配置",
  "fallback-provider": "容灾数据源",
  "candidate-provider": "候选数据源",
  "enrichment-provider": "数据增强",
  "planned-provider": "计划接入",
  "licensed-provider": "授权数据源",
};

function isViewId(value: string | null): value is ViewId {
  return VIEW_ITEMS.some((item) => item.id === value);
}

function readinessLabel(status: CapabilityCenterItem["readiness"]["status"]) {
  if (status === "ready") return "可直接使用";
  if (status === "warning") return "需关注";
  if (status === "blocked") return "存在阻断";
  return "规划中";
}

function readinessClass(status: CapabilityCenterItem["readiness"]["status"]) {
  if (status === "ready") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-500";
  if (status === "warning") return "border-amber-500/25 bg-amber-500/10 text-amber-500";
  if (status === "blocked") return "border-red-500/25 bg-red-500/10 text-red-500";
  return "border-blue-500/25 bg-blue-500/10 text-blue-500";
}

function providerLabel(status: string) {
  if (status === "available") return "可用";
  if (status === "degraded") return "降级";
  if (status === "planned") return "计划接入";
  return status;
}

function providerClass(status: string) {
  if (status === "available") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-500";
  if (status === "degraded") return "border-amber-500/25 bg-amber-500/10 text-amber-500";
  return "border-border bg-muted/40 text-muted-foreground";
}

function MetricCard({ icon, label, value, helper, tone = "primary" }: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  helper: string;
  tone?: "primary" | "emerald" | "amber" | "blue";
}) {
  const toneClass = {
    primary: "bg-primary/10 text-primary",
    emerald: "bg-emerald-500/10 text-emerald-500",
    amber: "bg-amber-500/10 text-amber-500",
    blue: "bg-blue-500/10 text-blue-500",
  }[tone];

  return (
    <div className="rounded-xl border border-border/60 bg-card/85 px-4 py-4 shadow-[0_16px_38px_-32px_hsl(var(--shadow-color)/0.55)] sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 text-xl font-bold tracking-tight text-foreground sm:text-2xl">{value}</p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{helper}</p>
        </div>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", toneClass)}>{icon}</span>
      </div>
    </div>
  );
}

function SectionHeader({ eyebrow, title, description, action }: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-[10px] font-bold tracking-[0.16em] text-primary">{eyebrow}</p>
        <h2 className="mt-1.5 text-xl font-bold tracking-tight text-foreground">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

function CapabilityCard({ capability, groupName, onOpen }: {
  capability: CapabilityCenterItem;
  groupName: string;
  onOpen: () => void;
}) {
  const Icon = CAPABILITY_ICONS[capability.id] ?? Sparkles;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-[286px] flex-col rounded-xl border border-border/60 bg-card/90 p-5 text-left shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)] transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_24px_50px_-34px_hsl(var(--primary)/0.35)]"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span>
        <Badge className={cn("font-medium hover:bg-inherit", readinessClass(capability.readiness.status))}>{readinessLabel(capability.readiness.status)}</Badge>
      </div>
      <p className="mt-5 text-[10px] font-bold tracking-[0.14em] text-muted-foreground">{groupName}</p>
      <h3 className="mt-1 text-lg font-bold text-foreground group-hover:text-primary">{capability.name}</h3>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{capability.description}</p>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {capability.tags.slice(0, 4).map((tag) => <Badge key={tag} variant="outline" className="border-border/60 bg-background/60 text-[10px] text-muted-foreground">{tag}</Badge>)}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border/40 pt-4 text-xs">
        <span className="text-muted-foreground">{capability.validationRules.length} 条交付规则</span>
        <span className="inline-flex items-center gap-1 font-semibold text-primary">查看业务知识 <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
      </div>
    </button>
  );
}

function CapabilityDetailSheet({ capability, groupName, open, onOpenChange }: {
  capability: CapabilityCenterItem | null;
  groupName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!capability) return null;
  const Icon = CAPABILITY_ICONS[capability.id] ?? Sparkles;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[min(680px,calc(100vw-16px))] max-w-none flex-col gap-0 overflow-hidden border-l border-border bg-background p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border/50 bg-card/80 px-5 py-5 text-left">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-lg">{capability.name}</SheetTitle>
                <Badge className={cn("hover:bg-inherit", readinessClass(capability.readiness.status))}>{readinessLabel(capability.readiness.status)}</Badge>
              </div>
              <SheetDescription className="mt-1 leading-5">{groupName} · {capability.description}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section className="rounded-xl border border-primary/20 bg-primary/5 p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-primary"><Compass className="h-4 w-4" />典型业务场景</p>
            <p className="mt-2 text-sm leading-6 text-foreground">{capability.inputHint}</p>
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><LibraryBig className="h-4 w-4 text-primary" />业务关注点</h3>
            <div className="mt-3 flex flex-wrap gap-2">{capability.tags.map((tag) => <Badge key={tag} variant="outline" className="bg-card">{tag}</Badge>)}</div>
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><CheckCircle2 className="h-4 w-4 text-emerald-500" />交付与验证标准</h3>
            <div className="mt-3 space-y-2">
              {capability.validationRules.map((rule, index) => (
                <div key={rule} className="flex gap-3 rounded-xl border border-border/60 bg-card p-3.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-[10px] font-bold text-emerald-500">{index + 1}</span>
                  <p className="text-xs leading-5 text-foreground">{rule}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><FileCheck2 className="h-4 w-4 text-blue-500" />标准交付物</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {capability.expectedArtifacts.map((artifact) => <code key={artifact} className="truncate rounded-lg border border-border/60 bg-muted/35 px-3 py-2 text-[11px] text-muted-foreground">{artifact}</code>)}
            </div>
          </section>

          <section className="rounded-xl border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Workflow className="h-4 w-4 text-primary" />执行支撑</h3>
              <Badge variant="outline">就绪度 {capability.readiness.score}%</Badge>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{capability.readiness.summary}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-bold tracking-wider text-muted-foreground">依赖 SKILLS</p>
                <div className="mt-2 space-y-1.5">
                  {capability.requiredSkills.map((skill) => (
                    <div key={skill.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/35 px-3 py-2 text-xs">
                      <span className="truncate text-foreground">{skill.name}</span>
                      <span className={skill.health === "ok" ? "text-emerald-500" : "text-red-500"}>{skill.health === "ok" ? "正常" : "异常"}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold tracking-wider text-muted-foreground">数据接口</p>
                <div className="mt-2 space-y-1.5">
                  {capability.dataEndpoints.map((endpoint) => <code key={endpoint} className="block truncate rounded-lg bg-muted/35 px-3 py-2 text-[10px] text-muted-foreground">{endpoint}</code>)}
                </div>
              </div>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function OverviewView({ data, groupNameById, onViewChange, onOpenCapability, onOpenGroup }: {
  data: CapabilityCenterData;
  groupNameById: Map<string, string>;
  onViewChange: (view: ViewId) => void;
  onOpenCapability: (capability: CapabilityCenterItem) => void;
  onOpenGroup: (groupId: string) => void;
}) {
  const readinessRate = data.summary.capabilities ? Math.round((data.summary.readyCapabilities / data.summary.capabilities) * 100) : 0;
  const totalRules = data.capabilities.reduce((total, capability) => total + capability.validationRules.length, 0);

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/90 px-5 py-6 shadow-[0_24px_60px_-42px_hsl(var(--shadow-color)/0.65)] sm:px-7 lg:px-8 lg:py-8">
        <div className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-primary/12 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary"><BriefcaseBusiness className="mr-1.5 h-3.5 w-3.5" />QUANT BUSINESS KNOWLEDGE</Badge>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground sm:text-3xl lg:text-4xl">把业务问题，映射为可执行的量化能力</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">这里沉淀 QuantPilot 能解决的业务场景、分析关注点、交付标准和能力边界。数据、Skills 与接口是支撑资源，而不是平台本身。</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Button onClick={() => onViewChange("capabilities")} className="gap-2"><Compass className="h-4 w-4" />浏览能力目录</Button>
              <Button variant="outline" onClick={() => onViewChange("knowledge")} className="gap-2"><BookOpenCheck className="h-4 w-4" />查看业务知识</Button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4 rounded-2xl border border-border/60 bg-background/65 p-4 lg:min-w-[310px]">
            <div className="relative flex h-24 w-24 shrink-0 items-center justify-center rounded-full" style={{ background: `conic-gradient(hsl(var(--primary)) ${readinessRate * 3.6}deg, hsl(var(--muted)) 0deg)` }}>
              <div className="flex h-[78px] w-[78px] flex-col items-center justify-center rounded-full bg-card"><strong className="text-2xl text-foreground">{readinessRate}%</strong><span className="text-[10px] text-muted-foreground">可用能力</span></div>
            </div>
            <dl className="min-w-0 space-y-2.5 text-xs">
              <div className="flex justify-between gap-8"><dt className="text-muted-foreground">业务能力</dt><dd className="font-semibold text-foreground">{data.summary.capabilities}</dd></div>
              <div className="flex justify-between gap-8"><dt className="text-muted-foreground">业务领域</dt><dd className="font-semibold text-foreground">{data.groups.length}</dd></div>
              <div className="flex justify-between gap-8"><dt className="text-muted-foreground">交付规则</dt><dd className="font-semibold text-foreground">{totalRules}</dd></div>
            </dl>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={<BriefcaseBusiness className="h-4 w-4" />} label="业务能力" value={data.summary.capabilities} helper="覆盖完整量化分析链路" />
        <MetricCard icon={<CheckCircle2 className="h-4 w-4" />} label="可直接使用" value={data.summary.readyCapabilities} helper={`${data.summary.plannedCapabilities} 项仍在演进`} tone="emerald" />
        <MetricCard icon={<BookOpenCheck className="h-4 w-4" />} label="知识规则" value={totalRules} helper="约束业务交付质量" tone="blue" />
        <MetricCard icon={<Workflow className="h-4 w-4" />} label="支撑 Skills" value={data.summary.skills} helper={data.summary.skillErrors ? `${data.summary.skillErrors} 项异常` : "当前全部健康"} tone={data.summary.skillErrors ? "amber" : "primary"} />
      </section>

      <section className="space-y-4">
        <SectionHeader eyebrow="BUSINESS DOMAINS" title="三类业务领域" description="按照分析目标组织能力，而不是按数据库、接口或技术组件分类。" />
        <div className="grid gap-4 lg:grid-cols-3">
          {data.groups.map((group) => {
            const Icon = GROUP_ICONS[group.id] ?? BriefcaseBusiness;
            const capabilities = data.capabilities.filter((capability) => capability.groupId === group.id);
            const ready = capabilities.filter((capability) => capability.readiness.status === "ready").length;
            return (
              <button key={group.id} type="button" onClick={() => onOpenGroup(group.id)} className="group rounded-xl border border-border/60 bg-card/90 p-5 text-left shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)] transition-all hover:-translate-y-0.5 hover:border-primary/35">
                <div className="flex items-start justify-between gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span><Badge variant="secondary">{ready}/{capabilities.length} 可用</Badge></div>
                <h3 className="mt-5 text-lg font-bold text-foreground group-hover:text-primary">{group.name}</h3>
                <p className="mt-2 min-h-12 text-sm leading-6 text-muted-foreground">{group.description}</p>
                <div className="mt-4 flex flex-wrap gap-1.5">{capabilities.map((capability) => <span key={capability.id} className="rounded-md bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground">{capability.shortName}</span>)}</div>
                <span className="mt-5 inline-flex items-center gap-1 text-xs font-semibold text-primary">进入领域 <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeader eyebrow="READY TO USE" title="已就绪的业务场景" description="从典型问题出发，快速理解每项能力的适用范围与交付内容。" action={<Button variant="ghost" size="sm" onClick={() => onViewChange("capabilities")} className="gap-1 text-xs">查看全部 <ArrowRight className="h-3.5 w-3.5" /></Button>} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {data.capabilities.filter((capability) => capability.readiness.status === "ready").slice(0, 4).map((capability) => {
            const Icon = CAPABILITY_ICONS[capability.id] ?? Sparkles;
            return (
              <button key={capability.id} type="button" onClick={() => onOpenCapability(capability)} className="group rounded-xl border border-border/60 bg-card/85 p-4 text-left transition-all hover:border-primary/35 hover:bg-primary/[0.035]">
                <div className="flex items-center justify-between"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span><ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" /></div>
                <h3 className="mt-4 text-sm font-semibold text-foreground">{capability.name}</h3>
                <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">{capability.inputHint}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-border/60 bg-card/85 p-5 sm:p-6">
        <SectionHeader eyebrow="KNOWLEDGE MODEL" title="一项业务能力如何被定义" description="统一从用户问题到质量验证的知识链路，让能力可理解、可执行、可复核。" />
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { step: "01", icon: Compass, title: "业务场景", text: "识别用户目标、标的与分析范围" },
            { step: "02", icon: LibraryBig, title: "分析知识", text: "明确指标、证据和风险关注点" },
            { step: "03", icon: FileCheck2, title: "交付契约", text: "定义结构化数据与页面产物" },
            { step: "04", icon: ShieldCheck, title: "质量规则", text: "验证完整性、真实性和展示质量" },
          ].map((item) => <div key={item.step} className="rounded-xl border border-border/50 bg-background/60 p-4"><div className="flex items-center justify-between"><span className="text-[10px] font-bold tracking-wider text-primary">STEP {item.step}</span><item.icon className="h-4 w-4 text-muted-foreground" /></div><p className="mt-5 text-sm font-semibold text-foreground">{item.title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.text}</p></div>)}
        </div>
      </section>
    </div>
  );
}

function CapabilitiesView({ data, groupNameById, keyword, groupFilter, statusFilter, onKeywordChange, onGroupFilterChange, onStatusFilterChange, onOpen }: {
  data: CapabilityCenterData;
  groupNameById: Map<string, string>;
  keyword: string;
  groupFilter: string;
  statusFilter: StatusFilter;
  onKeywordChange: (value: string) => void;
  onGroupFilterChange: (value: string) => void;
  onStatusFilterChange: (value: StatusFilter) => void;
  onOpen: (capability: CapabilityCenterItem) => void;
}) {
  const filtered = data.capabilities.filter((capability) => {
    const normalized = keyword.trim().toLowerCase();
    if (groupFilter !== "all" && capability.groupId !== groupFilter) return false;
    if (statusFilter === "ready" && capability.readiness.status !== "ready") return false;
    if (statusFilter === "planned" && capability.readiness.status !== "planned") return false;
    if (statusFilter === "attention" && !["warning", "blocked"].includes(capability.readiness.status)) return false;
    if (!normalized) return true;
    return [capability.name, capability.description, capability.inputHint, ...capability.tags].join(" ").toLowerCase().includes(normalized);
  });

  return (
    <div className="space-y-5">
      <SectionHeader eyebrow="CAPABILITY CATALOG" title="量化业务能力目录" description="按业务领域和成熟度检索能力，查看适用场景、分析关注点和交付标准。" />
      <div className="rounded-xl border border-border/60 bg-card/85 p-3 shadow-[0_16px_38px_-32px_hsl(var(--shadow-color)/0.55)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1 lg:max-w-[420px]"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={keyword} onChange={(event) => onKeywordChange(event.target.value)} placeholder="搜索业务能力、场景或关注点..." aria-label="搜索业务能力、场景或关注点" className="h-10 bg-background pl-9" /></div>
          <div className="platform-nav-scroll flex min-w-0 gap-2 overflow-x-auto">
            <button type="button" onClick={() => onGroupFilterChange("all")} className={cn("h-9 shrink-0 rounded-full border px-3 text-xs font-medium", groupFilter === "all" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground")}>全部领域</button>
            {data.groups.map((group) => <button key={group.id} type="button" onClick={() => onGroupFilterChange(group.id)} className={cn("h-9 shrink-0 rounded-full border px-3 text-xs font-medium", groupFilter === group.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground")}>{group.name}</button>)}
          </div>
          <div className="platform-nav-scroll flex min-w-0 gap-2 overflow-x-auto lg:ml-auto">
            {([{ id: "all", label: "全部状态" }, { id: "ready", label: "可使用" }, { id: "planned", label: "规划中" }, { id: "attention", label: "需关注" }] as Array<{ id: StatusFilter; label: string }>).map((item) => <button key={item.id} type="button" onClick={() => onStatusFilterChange(item.id)} className={cn("h-9 shrink-0 rounded-full border px-3 text-xs font-medium", statusFilter === item.id ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground")}>{item.label}</button>)}
          </div>
        </div>
      </div>
      {filtered.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((capability) => <CapabilityCard key={capability.id} capability={capability} groupName={groupNameById.get(capability.groupId) ?? capability.groupId} onOpen={() => onOpen(capability)} />)}</div> : <EmptyState title="没有匹配的业务能力" description="调整关键词、业务领域或成熟度筛选后重试。" action={{ label: "清除筛选", onClick: () => { onKeywordChange(""); onGroupFilterChange("all"); onStatusFilterChange("all"); } }} />}
    </div>
  );
}

function KnowledgeView({ data, groupNameById, onOpen }: { data: CapabilityCenterData; groupNameById: Map<string, string>; onOpen: (capability: CapabilityCenterItem) => void }) {
  return (
    <div className="space-y-5">
      <SectionHeader eyebrow="BUSINESS PLAYBOOKS" title="业务知识与交付规范" description="每项能力都是一份可执行的业务 Playbook：从典型问题、分析重点到质量门槛。" />
      <div className="grid gap-4 xl:grid-cols-2">
        {data.capabilities.map((capability) => {
          const Icon = CAPABILITY_ICONS[capability.id] ?? BookOpenCheck;
          return (
            <article key={capability.id} className="overflow-hidden rounded-xl border border-border/60 bg-card/90 shadow-[0_18px_42px_-34px_hsl(var(--shadow-color)/0.55)]">
              <div className="flex items-start gap-3 border-b border-border/40 p-5"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-bold text-foreground">{capability.name}</h3><Badge className={cn("hover:bg-inherit", readinessClass(capability.readiness.status))}>{readinessLabel(capability.readiness.status)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{groupNameById.get(capability.groupId)}</p></div></div>
              <div className="grid gap-px bg-border/40 sm:grid-cols-2">
                <div className="bg-card p-4"><p className="text-[10px] font-bold tracking-wider text-primary">典型问题</p><p className="mt-2 line-clamp-3 text-xs leading-5 text-foreground">{capability.inputHint}</p></div>
                <div className="bg-card p-4"><p className="text-[10px] font-bold tracking-wider text-primary">业务关注点</p><div className="mt-2 flex flex-wrap gap-1.5">{capability.tags.slice(0, 4).map((tag) => <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>)}</div></div>
                <div className="bg-card p-4 sm:col-span-2"><p className="text-[10px] font-bold tracking-wider text-primary">关键交付规则</p><div className="mt-2 space-y-1.5">{capability.validationRules.slice(0, 2).map((rule) => <p key={rule} className="flex gap-2 text-xs leading-5 text-muted-foreground"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />{rule}</p>)}</div></div>
              </div>
              <button type="button" onClick={() => onOpen(capability)} className="flex w-full items-center justify-between px-5 py-3 text-xs font-semibold text-primary transition-colors hover:bg-primary/5"><span>{capability.validationRules.length} 条规则 · {capability.expectedArtifacts.length} 项标准产物</span><span className="inline-flex items-center gap-1">查看完整 Playbook <ArrowRight className="h-3.5 w-3.5" /></span></button>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ProviderCard({ provider }: { provider: CapabilityCenterDataProvider }) {
  return (
    <article className="rounded-xl border border-border/60 bg-card/90 p-4 shadow-[0_14px_34px_-30px_hsl(var(--shadow-color)/0.5)]">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-foreground">{provider.name}</h3><p className="mt-0.5 text-[10px] font-medium text-muted-foreground">{CATEGORY_LABELS[provider.category] ?? provider.category}</p></div><Badge className={cn("shrink-0 hover:bg-inherit", providerClass(provider.status))}>{providerLabel(provider.status)}</Badge></div>
      <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">{provider.description}</p>
      <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-3 text-[11px] text-muted-foreground"><span>{provider.endpoints.length} 个接口</span><span>{provider.cacheTtlSeconds ? `缓存 ${provider.cacheTtlSeconds}s` : "按需更新"}</span></div>
    </article>
  );
}

function ResourcesView({ data }: { data: CapabilityCenterData }) {
  const providersByCategory = new Map<string, CapabilityCenterDataProvider[]>();
  data.dataProviders.forEach((provider) => providersByCategory.set(provider.category, [...(providersByCategory.get(provider.category) ?? []), provider]));
  const uniqueSkills = new Map<string, CapabilityCenterItem["requiredSkills"][number]>();
  data.capabilities.forEach((capability) => capability.requiredSkills.forEach((skill) => uniqueSkills.set(skill.id, skill)));

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border/60 bg-card/90 p-5 shadow-[0_24px_60px_-42px_hsl(var(--shadow-color)/0.65)] sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">SUPPORTING RESOURCES</Badge><h2 className="mt-3 text-2xl font-bold tracking-tight text-foreground">业务能力背后的支撑资源</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Skills、数据接口与运行服务只负责支撑业务能力执行。在这里查看依赖健康度，而不是把它们误认为业务产品。</p></div><div className={cn("rounded-xl border px-4 py-3", data.marketApi.reachable ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5")}><div className="flex items-center gap-2 text-sm font-semibold text-foreground"><span className={cn("h-2 w-2 rounded-full", data.marketApi.reachable ? "bg-emerald-500" : "bg-red-500")} />市场数据服务{data.marketApi.reachable ? "在线" : "离线"}</div><p className="mt-1 font-mono text-[10px] text-muted-foreground">{data.marketApi.baseUrl}</p></div></div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={<Layers3 className="h-4 w-4" />} label="依赖 Skills" value={uniqueSkills.size} helper={data.summary.skillErrors ? `${data.summary.skillErrors} 项异常` : "全部健康"} />
        <MetricCard icon={<Database className="h-4 w-4" />} label="数据资源" value={data.summary.dataProviders} helper="跨业务能力共享" tone="blue" />
        <MetricCard icon={<CheckCircle2 className="h-4 w-4" />} label="当前可用" value={data.summary.availableProviders} helper="可进入执行链路" tone="emerald" />
        <MetricCard icon={<CircleAlert className="h-4 w-4" />} label="降级资源" value={data.summary.degradedProviders} helper="执行时显式提示" tone={data.summary.degradedProviders ? "amber" : "emerald"} />
      </section>

      <section className="space-y-4">
        <SectionHeader eyebrow="EXECUTION SKILLS" title="业务执行组件" description="由业务能力引用的可复用 Skills，以及它们当前的健康状态。" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from(uniqueSkills.values()).map((skill) => {
            const usedBy = data.capabilities.filter((capability) => capability.requiredSkills.some((item) => item.id === skill.id)).length;
            return <div key={skill.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/85 p-4"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Zap className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-foreground">{skill.name}</p><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{skill.id} · v{skill.version}</p></div><div className="text-right"><p className={cn("text-xs font-semibold", skill.health === "ok" ? "text-emerald-500" : "text-red-500")}>{skill.health === "ok" ? "正常" : "异常"}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{usedBy} 项能力</p></div></div>;
          })}
        </div>
      </section>

      <section className="space-y-5">
        <SectionHeader eyebrow="DATA DEPENDENCIES" title="数据与计算资源" description="按用途展示业务执行依赖；异常或降级会影响相关能力的可用性。" />
        {Array.from(providersByCategory.entries()).map(([category, providers]) => <div key={category}><div className="mb-2 flex items-center gap-2"><Database className="h-3.5 w-3.5 text-primary" /><h3 className="text-xs font-semibold text-foreground">{CATEGORY_LABELS[category] ?? category}</h3><Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">{providers.length}</Badge></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)}</div></div>)}
      </section>
    </div>
  );
}

export default function BusinessKnowledgeClient({ initialData }: Props) {
  const [data, setData] = useState(initialData);
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [keyword, setKeyword] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedCapability, setSelectedCapability] = useState<CapabilityCenterItem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupNameById = useMemo(
    () => new Map<string, string>(data.groups.map((group) => [group.id, group.name])),
    [data.groups],
  );

  const changeView = useCallback((view: ViewId) => {
    setActiveView(view);
    const url = new URL(window.location.href);
    if (view === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    const applyLocation = () => {
      const view = new URL(window.location.href).searchParams.get("view");
      setActiveView(isViewId(view) ? view : "overview");
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, []);

  const refresh = async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/quant/capability-center`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error ?? "刷新失败");
      setData(payload.data);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setIsRefreshing(false);
    }
  };

  const openCapability = (capability: CapabilityCenterItem) => {
    setSelectedCapability(capability);
    setSheetOpen(true);
  };

  const openGroup = (groupId: string) => {
    setGroupFilter(groupId);
    setKeyword("");
    setStatusFilter("all");
    changeView("capabilities");
  };

  return (
    <div className="platform-shell min-h-dvh">
      <PageHeader
        title="量化业务知识中心"
        badge={<Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">{data.summary.capabilities} 项能力</Badge>}
        subtitle={`业务场景、分析方法与交付规范 · 更新于 ${formatDate(data.generatedAt)}`}
      />
      <SubNav
        ariaLabel="业务知识视图"
        items={VIEW_ITEMS}
        activeId={activeView}
        onChange={(id) => changeView(id as ViewId)}
        actions={<Button aria-label="刷新知识状态" title="刷新知识状态" variant="outline" size="sm" onClick={refresh} disabled={isRefreshing} className="gap-1.5"><RefreshCcw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} /><span className="hidden sm:inline">刷新知识状态</span></Button>}
      />

      <main id={subNavPanelId(activeView)} role="tabpanel" aria-labelledby={subNavTabId(activeView)} tabIndex={0} className="platform-content mx-auto max-w-[1520px] space-y-6 px-3 py-5 sm:px-6 sm:py-7 lg:px-8">
        {error && <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-500">{error}</div>}
        {activeView === "overview" && <OverviewView data={data} groupNameById={groupNameById} onViewChange={changeView} onOpenCapability={openCapability} onOpenGroup={openGroup} />}
        {activeView === "capabilities" && <CapabilitiesView data={data} groupNameById={groupNameById} keyword={keyword} groupFilter={groupFilter} statusFilter={statusFilter} onKeywordChange={setKeyword} onGroupFilterChange={setGroupFilter} onStatusFilterChange={setStatusFilter} onOpen={openCapability} />}
        {activeView === "knowledge" && <KnowledgeView data={data} groupNameById={groupNameById} onOpen={openCapability} />}
        {activeView === "resources" && <ResourcesView data={data} />}
        <CapabilityDetailSheet capability={selectedCapability} groupName={selectedCapability ? groupNameById.get(selectedCapability.groupId) ?? selectedCapability.groupId : ""} open={sheetOpen} onOpenChange={setSheetOpen} />
      </main>
    </div>
  );
}
