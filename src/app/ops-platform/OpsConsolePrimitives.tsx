"use client";

import type { ReactNode } from "react";
import {
  CheckCircle2,
  CircleHelp,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { OpsCheckStatus } from "@/lib/ops/ops-platform";

export const OPS_STATUS_LABEL: Record<OpsCheckStatus, string> = {
  ok: "正常",
  warning: "需关注",
  failed: "异常",
  unknown: "未知",
};

export function opsStatusClass(status: OpsCheckStatus) {
  if (status === "ok") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-500";
  if (status === "warning") return "border-amber-500/25 bg-amber-500/10 text-amber-500";
  if (status === "failed") return "border-red-500/25 bg-red-500/10 text-red-500";
  return "border-border bg-muted/50 text-muted-foreground";
}

export function OpsStatusIcon({ status, className }: { status: OpsCheckStatus; className?: string }) {
  if (status === "ok") return <CheckCircle2 className={cn("h-4 w-4 text-emerald-500", className)} />;
  if (status === "warning") return <TriangleAlert className={cn("h-4 w-4 text-amber-500", className)} />;
  if (status === "failed") return <XCircle className={cn("h-4 w-4 text-red-500", className)} />;
  return <CircleHelp className={cn("h-4 w-4 text-muted-foreground", className)} />;
}

export function OpsStatusBadge({ status, label }: { status: OpsCheckStatus; label?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold", opsStatusClass(status))}>
      <OpsStatusIcon status={status} className="h-3 w-3" />
      {label ?? OPS_STATUS_LABEL[status]}
    </span>
  );
}

const TONE_CLASS = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/10 text-emerald-500",
  amber: "bg-amber-500/10 text-amber-500",
  red: "bg-red-500/10 text-red-500",
  blue: "bg-blue-500/10 text-blue-500",
  slate: "bg-muted text-muted-foreground",
};

export function OpsMetricCard({
  icon,
  label,
  value,
  helper,
  tone = "primary",
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  helper: string;
  tone?: keyof typeof TONE_CLASS;
}) {
  return (
    <article className="rounded-xl border border-border/60 bg-card/90 p-4 shadow-[0_16px_38px_-32px_hsl(var(--shadow-color)/0.55)] sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">{value}</p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{helper}</p>
        </div>
        <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", TONE_CLASS[tone])}>{icon}</span>
      </div>
    </article>
  );
}

export function OpsSectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
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
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function OpsProgress({ value, status }: { value: number; status: OpsCheckStatus }) {
  const color = status === "ok" ? "bg-emerald-500" : status === "warning" ? "bg-amber-500" : status === "failed" ? "bg-red-500" : "bg-muted-foreground";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full transition-[width]", color)} style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
    </div>
  );
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
