"use client";

import type { ReactNode } from "react";
import {
  CheckCircle2,
  CircleDashed,
  CircleX,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const RESEARCH_STATUS_LABEL: Record<string, string> = {
  available: "可用",
  partial: "部分可用",
  unavailable: "不可用",
  disabled: "未启用",
  active: "已启用",
  configured: "已配置",
  completed: "已完成",
  running: "运行中",
  failed: "失败",
  dry_run: "模拟推送",
  queued: "已入队",
  delivered: "已送达",
  skipped: "已跳过",
};

export function researchStatusClass(status: string) {
  if (["available", "active", "completed", "delivered"].includes(status)) return "border-emerald-500/25 bg-emerald-500/10 text-emerald-500";
  if (["partial", "configured", "dry_run", "queued", "running"].includes(status)) return "border-blue-500/25 bg-blue-500/10 text-blue-500";
  if (["unavailable", "failed"].includes(status)) return "border-red-500/25 bg-red-500/10 text-red-500";
  return "border-border bg-muted/50 text-muted-foreground";
}

export function ResearchStatusIcon({ status, className }: { status: string; className?: string }) {
  if (["available", "active", "completed", "delivered"].includes(status)) return <CheckCircle2 className={cn("h-4 w-4 text-emerald-500", className)} />;
  if (["partial", "configured", "dry_run", "queued", "running"].includes(status)) return <TriangleAlert className={cn("h-4 w-4 text-blue-500", className)} />;
  if (["unavailable", "failed"].includes(status)) return <CircleX className={cn("h-4 w-4 text-red-500", className)} />;
  return <CircleDashed className={cn("h-4 w-4 text-muted-foreground", className)} />;
}

export function ResearchStatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold", researchStatusClass(status))}>
      <ResearchStatusIcon status={status} className="h-3 w-3" />
      {label ?? RESEARCH_STATUS_LABEL[status] ?? status}
    </span>
  );
}

const TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/10 text-emerald-500",
  amber: "bg-amber-500/10 text-amber-500",
  red: "bg-red-500/10 text-red-500",
  blue: "bg-blue-500/10 text-blue-500",
  violet: "bg-violet-500/10 text-violet-500",
  slate: "bg-muted text-muted-foreground",
};

export function ResearchMetricCard({ icon, label, value, helper, tone = "primary" }: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  helper: string;
  tone?: keyof typeof TONES;
}) {
  return (
    <article data-research-metric className="rounded-xl border border-border/65 bg-card/90 p-3.5 transition-colors hover:border-border sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-[11px] font-medium text-muted-foreground sm:text-xs">{label}</p><p className="mt-1.5 text-[1.35rem] font-bold tracking-tight text-foreground sm:mt-2 sm:text-2xl">{value}</p><p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground sm:text-[11px] sm:leading-5">{helper}</p></div>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 sm:rounded-xl", TONES[tone])}>{icon}</span>
      </div>
    </article>
  );
}

export function ResearchSectionHeader({ eyebrow, title, description, action }: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="hidden text-[10px] font-bold tracking-[0.16em] text-primary sm:block">{eyebrow}</p><h2 className="text-xl font-bold tracking-tight text-foreground sm:mt-1.5">{title}</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p></div>
      {action}
    </div>
  );
}

export function riskLabel(risk: string) {
  if (risk === "low") return "低风险";
  if (risk === "medium") return "中风险";
  if (risk === "high") return "高风险";
  return risk || "未评估";
}

export function riskClass(risk: string) {
  if (risk === "low") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-500";
  if (risk === "medium") return "border-amber-500/25 bg-amber-500/10 text-amber-500";
  if (risk === "high") return "border-red-500/25 bg-red-500/10 text-red-500";
  return "border-border bg-muted text-muted-foreground";
}

export function scoreTone(score: number | null) {
  if (score == null) return "text-muted-foreground";
  if (score >= 80) return "text-emerald-500";
  if (score >= 65) return "text-blue-500";
  return "text-amber-500";
}
