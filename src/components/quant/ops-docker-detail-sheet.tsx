"use client";

import { useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Container,
  Cpu,
  ExternalLink,
  Globe,
  HardDrive,
  Layers3,
  MemoryStick,
  Network,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatCompactDate as formatDate } from "@/components/quant/console-primitives";
import type { DockerContainer } from "@/lib/ops/docker";

function containerStatusBadge(status: string) {
  const config: Record<string, { className: string; label: string }> = {
    running: { className: "border-emerald-200/60 bg-emerald-50 text-emerald-700", label: "运行中" },
    stopped: { className: "border-slate-200/60 bg-slate-50 text-slate-700", label: "已停止" },
    paused: { className: "border-amber-200/60 bg-amber-50 text-amber-700", label: "已暂停" },
    restarting: { className: "border-blue-200/60 bg-blue-50 text-blue-700", label: "重启中" },
    unhealthy: { className: "border-red-200/60 bg-red-50 text-red-700", label: "异常" },
    unknown: { className: "border-border/60 bg-muted/30 text-muted-foreground", label: "未知" },
  };
  const cfg = config[status] ?? config.unknown;
  return <Badge className={cfg.className}>{cfg.label}</Badge>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 py-2 text-sm">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all font-medium text-foreground">{value}</span>
    </div>
  );
}

function ResourceProgress({
  label,
  value,
  max,
  unit,
  icon: Icon,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  icon: typeof Cpu;
}) {
  const percent = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color =
    percent > 80 ? "bg-red-500" : percent > 60 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="h-3 w-3" />
          {label}
        </span>
        <span className="tabular-nums font-medium text-foreground">
          {value} / {max} {unit}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

type CollapsibleSectionProps = {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

function CollapsibleSection({ title, defaultOpen = false, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors"
      >
        {title}
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="border-t border-border/40 px-4 py-3">{children}</div>}
    </div>
  );
}

export function OpsDockerDetailSheet({
  container,
  open,
  onOpenChange,
}: {
  container: DockerContainer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!container) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[min(440px,calc(100vw-24px))] max-w-none flex-col gap-0 overflow-y-auto border-l border-border bg-background p-0 sm:max-w-none">
        <SheetHeader className="sticky top-0 z-10 border-b border-border/40 bg-background/90 px-4 py-4 backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Container className="h-4 w-4" />
                </div>
                <SheetTitle className="truncate text-base">{container.service}</SheetTitle>
              </div>
              <SheetDescription className="mt-1 truncate font-mono text-xs">
                {container.name}
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button variant="ghost" size="icon" className="shrink-0">
                <X className="h-4 w-4" />
              </Button>
            </SheetClose>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-4 p-4">
          {/* Quick actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" disabled={container.status === "running"}>
              <Play className="h-3.5 w-3.5" />
              启动
            </Button>
            <Button variant="outline" size="sm" className="flex-1" disabled={container.status !== "running"}>
              <Square className="h-3.5 w-3.5" />
              停止
            </Button>
            <Button variant="outline" size="sm" className="flex-1">
              <RotateCcw className="h-3.5 w-3.5" />
              重启
            </Button>
          </div>

          {/* Status badge */}
          <div className="flex flex-wrap items-center gap-2">
            {containerStatusBadge(container.status)}
            {container.health.status !== "none" && (
              <Badge className={
                container.health.status === "healthy"
                  ? "border-emerald-200/60 bg-emerald-50 text-emerald-700"
                  : container.health.status === "unhealthy"
                    ? "border-red-200/60 bg-red-50 text-red-700"
                    : "border-amber-200/60 bg-amber-50 text-amber-700"
              }>
                <ShieldCheck className="mr-1 h-3 w-3" />
                {container.health.status === "healthy" ? "健康" : container.health.status === "unhealthy" ? "异常" : "启动中"}
              </Badge>
            )}
            {container.restartCount > 0 && (
              <Badge variant="outline" className="text-muted-foreground">
                重启 {container.restartCount} 次
              </Badge>
            )}
          </div>

          {/* Basic info */}
          <div className="rounded-xl border border-border/60 divide-y divide-border/40">
            <DetailRow label="容器 ID" value={container.id} />
            <DetailRow label="镜像" value={container.image} />
            <DetailRow label="状态" value={container.state} />
            <DetailRow label="创建时间" value={formatDate(container.createdAt)} />
            {container.startedAt && <DetailRow label="启动时间" value={formatDate(container.startedAt)} />}
            {container.uptime && <DetailRow label="运行时长" value={container.uptime} />}
          </div>

          {/* Ports */}
          {container.ports.length > 0 && (
            <div className="rounded-xl border border-border/60 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-3">
                <Globe className="h-3 w-3" />
                端口映射
              </p>
              <div className="space-y-1.5">
                {container.ports.map((p) => (
                  <div key={`${p.host}:${p.container}`} className="flex items-center gap-2 text-sm">
                    <Badge variant="outline" className="font-mono text-xs">
                      {p.host ?? "*"}:{p.container}
                    </Badge>
                    <span className="text-xs text-muted-foreground">&rarr; {p.container}/{p.protocol}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Resource usage */}
          {container.resources && (
            <div className="rounded-xl border border-border/60 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-3">
                <Cpu className="h-3 w-3" />
                资源使用
              </p>
              <div className="space-y-3">
                <ResourceProgress label="CPU" value={container.resources.cpuPercent} max={100} unit="%" icon={Cpu} />
                <ResourceProgress
                  label="内存"
                  value={container.resources.memoryUsageMb}
                  max={container.resources.memoryLimitMb}
                  unit="MB"
                  icon={MemoryStick}
                />
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Network className="h-3 w-3" />
                      网络 RX
                    </p>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                      {container.resources.networkRxMb.toFixed(1)} MB
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Network className="h-3 w-3" />
                      网络 TX
                    </p>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                      {container.resources.networkTxMb.toFixed(1)} MB
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <HardDrive className="h-3 w-3" />
                      磁盘读
                    </p>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                      {container.resources.blockReadMb.toFixed(1)} MB
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <HardDrive className="h-3 w-3" />
                      磁盘写
                    </p>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                      {container.resources.blockWriteMb.toFixed(1)} MB
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Labels */}
          {Object.keys(container.labels).length > 0 && (
            <CollapsibleSection title="容器标签">
              <div className="space-y-2">
                {Object.entries(container.labels).map(([key, value]) => (
                  <div key={key} className="flex items-start gap-3 text-xs">
                    <span className="w-36 shrink-0 truncate font-mono text-muted-foreground">{key}</span>
                    <span className="min-w-0 break-all font-medium text-foreground">{value}</span>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Logs button */}
          <Button variant="outline" className="w-full" asChild>
            <a href={`http://localhost:3001/explore`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
              在 Grafana 中查看日志
            </a>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
