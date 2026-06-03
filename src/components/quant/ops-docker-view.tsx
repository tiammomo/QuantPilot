"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  Box,
  Circle,
  Container,
  Cpu,
  HardDrive,
  Layers3,
  Play,
  RotateCcw,
  Server,
  ShieldCheck,
  Square,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, StatTile } from "@/components/quant/eval-console-primitives";
import { formatCompactDate as formatDate } from "@/components/quant/console-primitives";
import { OpsDockerDetailSheet } from "@/components/quant/ops-docker-detail-sheet";
import type { DockerContainer, DockerDashboard } from "@/lib/ops/docker";

function containerStatusDot(status: string) {
  const map: Record<string, string> = {
    running: "bg-emerald-500",
    stopped: "bg-slate-400",
    paused: "bg-amber-500",
    restarting: "bg-blue-500",
    unhealthy: "bg-red-500",
    unknown: "bg-slate-300",
  };
  return map[status] ?? map.unknown;
}

function containerStatusLabel(status: string) {
  const map: Record<string, string> = {
    running: "运行中",
    stopped: "已停止",
    paused: "已暂停",
    restarting: "重启中",
    unhealthy: "异常",
    unknown: "未知",
  };
  return map[status] ?? status;
}

function healthBadge(status: string) {
  const config: Record<string, { className: string; label: string }> = {
    healthy: { className: "border-emerald-200/60 bg-emerald-50 text-emerald-700", label: "健康" },
    unhealthy: { className: "border-red-200/60 bg-red-50 text-red-700", label: "异常" },
    starting: { className: "border-amber-200/60 bg-amber-50 text-amber-700", label: "启动中" },
    none: { className: "border-border/60 bg-muted/30 text-muted-foreground", label: "无检查" },
  };
  const cfg = config[status] ?? config.none;
  return <Badge className={cfg.className}>{cfg.label}</Badge>;
}

function portDisplay(ports: DockerContainer["ports"]) {
  if (!ports.length) return <span className="text-muted-foreground">-</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {ports.map((p) => (
        <Badge key={`${p.host}:${p.container}`} variant="outline" className="font-mono text-xs text-muted-foreground">
          {p.host ?? "*"}:{p.container}
        </Badge>
      ))}
    </div>
  );
}

function resourceBar(value: number, tone: "cpu" | "memory") {
  const color = tone === "cpu"
    ? value > 80 ? "bg-red-500" : value > 50 ? "bg-amber-500" : "bg-emerald-500"
    : value > 80 ? "bg-red-500" : value > 60 ? "bg-amber-500" : "bg-blue-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{value.toFixed(1)}%</span>
    </div>
  );
}

function DockerStatBar({ dashboard }: { dashboard: DockerDashboard }) {
  const { system } = dashboard;
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <StatTile
        icon={<Box className="h-4 w-4" />}
        label="运行中容器"
        value={system.runningContainers}
        helper={`共 ${system.totalContainers} 个容器`}
        tone="emerald"
      />
      <StatTile
        icon={<Square className="h-4 w-4" />}
        label="已停止"
        value={system.stoppedContainers}
        helper={`${system.totalImages} 个镜像`}
        tone={system.stoppedContainers ? "red" : "slate"}
      />
      <StatTile
        icon={<Cpu className="h-4 w-4" />}
        label="系统资源"
        value={`${system.cpuCount}C`}
        helper={`${system.totalMemoryGb} GB · ${system.architecture}`}
        tone="blue"
      />
      <StatTile
        icon={<HardDrive className="h-4 w-4" />}
        label="存储卷"
        value={system.totalVolumes}
        helper={`${system.storageDriver} · Docker ${system.serverVersion}`}
        tone="amber"
      />
    </section>
  );
}

function DockerContainerList({
  containers,
  onSelectContainer,
}: {
  containers: DockerContainer[];
  onSelectContainer: (container: DockerContainer) => void;
}) {
  return (
    <Panel
      title="容器列表"
      icon={<Container className="h-4 w-4 text-primary" />}
      action={
        <Badge variant="outline" className="text-muted-foreground">
          {containers.length}
        </Badge>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="bg-muted/60 text-left text-xs font-semibold text-muted-foreground">
            <tr>
              <th className="w-[22%] px-4 py-3">容器</th>
              <th className="w-[18%] px-4 py-3">镜像</th>
              <th className="w-[16%] px-4 py-3">端口</th>
              <th className="w-[10%] px-4 py-3">健康</th>
              <th className="w-[10%] px-4 py-3">CPU</th>
              <th className="w-[10%] px-4 py-3">内存</th>
              <th className="w-[14%] px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => (
              <tr
                key={c.id}
                className="group border-t border-border/40 bg-card transition-colors hover:bg-muted/30 cursor-pointer"
                onClick={() => onSelectContainer(c)}
              >
                <td className="px-4 py-3 align-top">
                  <div className="flex items-start gap-2.5">
                    <Circle className={`mt-0.5 h-2.5 w-2.5 shrink-0 fill-current ${containerStatusDot(c.status)}`} />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{c.service}</p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{c.name}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{containerStatusLabel(c.status)} · {c.uptime}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 align-top">
                  <p className="truncate font-mono text-xs text-foreground/80">{c.image.split(":").slice(-2).join(":")}</p>
                </td>
                <td className="px-4 py-3 align-top">{portDisplay(c.ports)}</td>
                <td className="px-4 py-3 align-top">{healthBadge(c.health.status)}</td>
                <td className="px-4 py-3 align-top">
                  {c.resources ? resourceBar(c.resources.cpuPercent, "cpu") : <span className="text-muted-foreground">-</span>}
                </td>
                <td className="px-4 py-3 align-top">
                  {c.resources ? resourceBar(c.resources.memoryPercent, "memory") : <span className="text-muted-foreground">-</span>}
                </td>
                <td className="px-4 py-3 text-right align-top">
                  <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button variant="ghost" size="icon" aria-label="启动" disabled={c.status === "running"}>
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="停止" disabled={c.status !== "running"}>
                      <Square className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="重启">
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function DockerResourcePanel({ containers }: { containers: DockerContainer[] }) {
  const withResources = containers.filter((c) => c.resources);
  return (
    <Panel title="资源监控" icon={<Cpu className="h-4 w-4 text-blue-600" />}>
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">CPU 使用率</p>
          {withResources.map((c) => (
            <div key={c.id} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">{c.service}</span>
                <span className="tabular-nums text-muted-foreground">{c.resources!.cpuPercent.toFixed(1)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${Math.min(c.resources!.cpuPercent, 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">内存使用率</p>
          {withResources.map((c) => (
            <div key={c.id} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">{c.service}</span>
                <span className="tabular-nums text-muted-foreground">
                  {c.resources!.memoryUsageMb} / {c.resources!.memoryLimitMb} MB
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all"
                  style={{ width: `${Math.min(c.resources!.memoryPercent, 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function DockerHealthPanel({
  containers,
  onSelectContainer,
}: {
  containers: DockerContainer[];
  onSelectContainer: (container: DockerContainer) => void;
}) {
  const statusIcon = (status: string) => {
    switch (status) {
      case "healthy":
        return <ShieldCheck className="h-4 w-4 text-emerald-600" />;
      case "unhealthy":
        return <TriangleAlert className="h-4 w-4 text-red-600" />;
      case "starting":
        return <Cpu className="h-4 w-4 animate-spin text-amber-600" />;
      default:
        return <Circle className="h-4 w-4 text-slate-400" />;
    }
  };

  return (
    <Panel title="健康检查" icon={<ShieldCheck className="h-4 w-4 text-emerald-600" />}>
      <div className="divide-y divide-border/40">
        {containers.map((c) => (
          <button
            key={c.id}
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/30"
            onClick={() => onSelectContainer(c)}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                {statusIcon(c.health.status)}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{c.service}</p>
                <p className="text-xs text-muted-foreground">
                  {c.health.status === "none"
                    ? "未配置健康检查"
                    : `最后检查: ${c.health.lastCheck ? formatDate(c.health.lastCheck) : "-"}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {c.health.failCount > 0 && (
                <Badge className="border-red-200/60 bg-red-50 text-red-700">
                  {c.health.failCount} 次失败
                </Badge>
              )}
              {healthBadge(c.health.status)}
            </div>
          </button>
        ))}
      </div>
    </Panel>
  );
}

function DockerVolumeList({ dashboard }: { dashboard: DockerDashboard }) {
  return (
    <Panel
      title="存储卷"
      icon={<HardDrive className="h-4 w-4 text-amber-600" />}
      action={
        <Badge variant="outline" className="text-muted-foreground">
          {dashboard.volumes.length}
        </Badge>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead className="bg-muted/60 text-left text-xs font-semibold text-muted-foreground">
            <tr>
              <th className="px-4 py-3">卷名</th>
              <th className="px-4 py-3">驱动</th>
              <th className="px-4 py-3">挂载点</th>
              <th className="px-4 py-3 text-right">大小</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.volumes.map((v) => (
              <tr key={v.name} className="border-t border-border/40 bg-card transition-colors hover:bg-muted/30">
                <td className="px-4 py-3">
                  <p className="font-mono text-xs font-medium text-foreground">{v.name}</p>
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className="text-muted-foreground">{v.driver}</Badge>
                </td>
                <td className="px-4 py-3">
                  <p className="truncate font-mono text-[11px] text-foreground/80 max-w-64">{v.mountpoint}</p>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground/80">{v.size ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function OpsDockerView({ dashboard }: { dashboard: DockerDashboard }) {
  const [selectedContainer, setSelectedContainer] = useState<DockerContainer | null>(null);

  return (
    <>
      <DockerStatBar dashboard={dashboard} />

      <DockerContainerList containers={dashboard.containers} onSelectContainer={setSelectedContainer} />

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <DockerResourcePanel containers={dashboard.containers} />
        <DockerHealthPanel containers={dashboard.containers} onSelectContainer={setSelectedContainer} />
      </section>

      <DockerVolumeList dashboard={dashboard} />

      <OpsDockerDetailSheet
        container={selectedContainer}
        open={selectedContainer !== null}
        onOpenChange={(open) => { if (!open) setSelectedContainer(null); }}
      />
    </>
  );
}
