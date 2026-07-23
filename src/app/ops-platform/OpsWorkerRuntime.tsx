"use client";

import { Activity, Clock3, Cpu, ListTodo, ServerCog } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import type { OpsCheckStatus } from "@/lib/ops/ops-platform";
import type { AgentWorkerRuntimeDashboard } from "@/lib/ops/agent-worker-observability";
import { cn } from "@/lib/utils";
import {
  OpsMetricCard,
  OpsSectionHeader,
  OpsStatusBadge,
} from "./OpsConsolePrimitives";

function opsStatus(status: AgentWorkerRuntimeDashboard["status"]): OpsCheckStatus {
  return status === "unavailable" ? "unknown" : status;
}

function ageLabel(seconds: number | null): string {
  if (seconds === null) return "无等待";
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3_600)} 小时 ${Math.floor((seconds % 3_600) / 60)} 分钟`;
}

function heartbeatLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function OpsWorkerRuntime({
  data,
}: {
  data: AgentWorkerRuntimeDashboard;
}) {
  const visibleWorkers = data.workers
    .filter((worker) => worker.status !== "stopped")
    .slice(0, 8);
  const queued = data.summary.pendingJobs + data.summary.retryWaitJobs;

  return (
    <section className="space-y-4">
      <OpsSectionHeader
        eyebrow="EXECUTION POOL"
        title="Data Agent 执行池"
        description="直接读取数据库 Worker registry、共享容量槽和 generation queue，不用通过进程日志猜测任务是否有人消费。"
        action={
          <OpsStatusBadge
            status={opsStatus(data.status)}
            label={data.dispatchMode === "worker" ? `${data.summary.activeWorkers} 个 Worker 在线` : "Inline 模式"}
          />
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OpsMetricCard
          icon={<ServerCog className="h-4 w-4" />}
          label="存活 Worker"
          value={data.summary.activeWorkers}
          helper={`进程并发合计 ${data.summary.processCapacity}`}
          tone={data.summary.activeWorkers ? "emerald" : data.dispatchMode === "worker" ? "red" : "blue"}
        />
        <OpsMetricCard
          icon={<Cpu className="h-4 w-4" />}
          label="全局执行槽"
          value={`${data.summary.heldSlots}/${data.summary.globalCapacity}`}
          helper={`${data.summary.availableSlots} 个可用 · ${data.summary.expiredSlots} 个过期`}
          tone={data.summary.expiredSlots ? "amber" : "blue"}
        />
        <OpsMetricCard
          icon={<ListTodo className="h-4 w-4" />}
          label="任务队列"
          value={queued}
          helper={`${data.summary.runningJobs} 个运行中 · ${data.summary.queuedActors} 个排队用户`}
          tone={queued && !data.summary.activeWorkers ? "red" : queued ? "amber" : "emerald"}
        />
        <OpsMetricCard
          icon={<Clock3 className="h-4 w-4" />}
          label="最久等待"
          value={ageLabel(data.summary.oldestQueueAgeSeconds)}
          helper={`24h 完成 ${data.summary.completedJobsLast24h} · 失败 ${data.summary.failedJobsLast24h}`}
          tone={data.summary.oldestQueueAgeSeconds && data.summary.oldestQueueAgeSeconds > 300 ? "amber" : "emerald"}
        />
      </div>

      {data.alerts.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2">
          {data.alerts.map((alert) => (
            <div
              key={alert.id}
              className={cn(
                "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
                alert.severity === "failed"
                  ? "border-red-500/25 bg-red-500/10"
                  : "border-amber-500/25 bg-amber-500/10",
              )}
            >
              <Activity className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                alert.severity === "failed" ? "text-red-500" : "text-amber-500",
              )} />
              <p className="leading-6 text-foreground">{alert.summary}</p>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="grid grid-cols-[minmax(0,1fr)_90px_110px_110px] gap-3 border-b border-border/60 bg-muted/35 px-4 py-2.5 text-[11px] font-semibold text-muted-foreground">
          <span>进程</span>
          <span>状态</span>
          <span>并发</span>
          <span>最近心跳</span>
        </div>
        {visibleWorkers.length > 0 ? visibleWorkers.map((worker) => (
          <div
            key={worker.id}
            className="grid grid-cols-[minmax(0,1fr)_90px_110px_110px] items-center gap-3 border-b border-border/40 px-4 py-3 text-xs last:border-b-0"
          >
            <div className="min-w-0">
              <p className="truncate font-semibold text-foreground">{worker.hostname}:{worker.processId}</p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{worker.id}</p>
            </div>
            <OpsStatusBadge
              status={worker.status === "running" ? "ok" : "warning"}
              label={worker.status === "running" ? "在线" : "心跳过期"}
            />
            <span className="font-mono text-foreground">{worker.processConcurrency} / {worker.globalConcurrency}</span>
            <span className="font-mono text-muted-foreground">{heartbeatLabel(worker.lastHeartbeatAt)}</span>
          </div>
        )) : (
          <EmptyState
            title={data.dispatchMode === "worker" ? "没有存活的 Worker" : "当前由 Web 进程内联执行"}
            description={data.dispatchMode === "worker" ? "启动独立 generation Worker 后，其进程注册和心跳会显示在这里。" : "切换到 worker 调度模式后可获得持久队列和独立执行池。"}
            className="border-0 py-8"
          />
        )}
      </div>
    </section>
  );
}
