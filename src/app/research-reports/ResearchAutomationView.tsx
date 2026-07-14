"use client";

import {
  Activity,
  Bell,
  CalendarClock,
  Database,
  Loader2,
  Radio,
  Send,
  TimerReset,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { ResearchAutomationDashboard } from "@/lib/quant/research-reports";
import {
  ResearchMetricCard,
  ResearchSectionHeader,
  ResearchStatusBadge,
} from "./ResearchConsolePrimitives";
import { formatResearchTime } from "./researchViewModel";

function scheduleValue(schedule: Record<string, unknown>, key: string, fallback: string) {
  const value = schedule[key];
  return typeof value === "string" ? value : fallback;
}

function scheduleEnabled(schedule: Record<string, unknown>) {
  return schedule.enabled === true;
}

export function ResearchAutomationView({ data, onSend, isSending }: {
  data: ResearchAutomationDashboard;
  onSend: (reportId?: string) => void;
  isSending: boolean;
}) {
  const completedRuns = data.recentRuns.filter((run) => run.status === "completed").length;
  const failedRuns = data.recentRuns.filter((run) => run.status === "failed").length;
  const readyProviders = data.providerMatrix.filter((provider) => provider.status === "available" || provider.status === "partial").length;
  const enabledSchedules = data.watchlists.filter((watchlist) => scheduleEnabled(watchlist.schedule)).length;
  const dryRunChannels = data.notificationChannels.filter((channel) => channel.isDryRun).length;
  return (
    <div className="space-y-6 sm:space-y-8">
      <ResearchSectionHeader eyebrow="SOURCE & AUTOMATION" title="研究源与自动化链路" description="统一查看观察池计划、数据源边界、生成运行和推送回执；真实推送与 dry-run 明确区分。" action={<Button variant="outline" onClick={() => onSend()} disabled={!data.latestReports.length || isSending}>{isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}推送最新报告</Button>} />
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <ResearchMetricCard icon={<Activity className="h-4 w-4" />} label="近期运行" value={`${completedRuns}/${data.recentRuns.length}`} helper={`${failedRuns} 次失败 · 仅统计最近记录`} tone={failedRuns ? "amber" : completedRuns ? "emerald" : "slate"} />
        <ResearchMetricCard icon={<Database className="h-4 w-4" />} label="证据源就绪" value={`${readyProviders}/${data.providerMatrix.length}`} helper="可用或支持降级采样" tone={readyProviders ? "blue" : "red"} />
        <ResearchMetricCard icon={<CalendarClock className="h-4 w-4" />} label="自动计划" value={`${enabledSchedules}/${data.watchlists.length}`} helper="未启用时仅支持手动生成" tone={enabledSchedules ? "emerald" : "amber"} />
        <ResearchMetricCard icon={<Bell className="h-4 w-4" />} label="推送通道" value={data.summary.activeChannels} helper={`${dryRunChannels} 个 dry-run 通道`} tone={dryRunChannels === data.summary.activeChannels ? "violet" : "emerald"} />
      </section>

      <section className="space-y-4">
        <ResearchSectionHeader eyebrow="WATCHLISTS" title="观察池与生成计划" description="研究对象、市场范围、日报模板、时区和推送通道均来自持久化配置。" />
        <div className={cn("grid gap-4", data.watchlists.length > 1 && "lg:grid-cols-2")}>{data.watchlists.map((watchlist) => (
          <article key={watchlist.id} className="rounded-xl border border-border/65 bg-card p-5 transition-colors hover:border-border">
            <div className="flex items-start justify-between gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Radio className="h-5 w-5" /></span><ResearchStatusBadge status={watchlist.status} /></div>
            <h3 className="mt-4 text-base font-bold text-foreground">{watchlist.name}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{watchlist.description}</p>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{[["股票池", watchlist.universeId ?? "未绑定"], ["模板", watchlist.reportTemplate], ["计划", `${scheduleValue(watchlist.schedule, "frequency", "manual")} ${scheduleValue(watchlist.schedule, "time", "-")}`], ["时区", scheduleValue(watchlist.schedule, "timezone", "local")]].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg bg-muted/45 p-2.5"><p className="text-[10px] text-muted-foreground">{label}</p><p title={value} className="mt-1 line-clamp-2 break-all text-xs font-semibold text-foreground">{value}</p></div>)}</div>
            <div className="mt-4 flex flex-wrap gap-1.5">{watchlist.symbols.map((symbol) => <Badge key={symbol} variant="outline" className="font-mono text-[10px]">{symbol}</Badge>)}{watchlist.markets.map((market) => <Badge key={market} className="bg-primary/10 text-[10px] text-primary hover:bg-primary/10">{market}</Badge>)}</div>
            <div className="mt-4 flex items-center justify-between border-t border-border/40 pt-4 text-xs text-muted-foreground"><span>{watchlist.notificationChannelIds.length} 个关联通道</span><ResearchStatusBadge status={scheduleEnabled(watchlist.schedule) ? "active" : "disabled"} label={scheduleEnabled(watchlist.schedule) ? "定时已启用" : "仅手动运行"} /></div>
          </article>
        ))}</div>
      </section>

      <section className="space-y-4">
        <ResearchSectionHeader eyebrow="PROVIDERS" title="数据与证据源矩阵" description="区分当前事实源、性能加速层、稳定回退路径和尚未启用的外部数据。" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">{data.providerMatrix.map((provider) => <article key={provider.id} className="rounded-xl border border-border/65 bg-card p-4"><div className="flex items-start justify-between gap-2"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500"><Database className="h-4 w-4" /></span><ResearchStatusBadge status={provider.status} /></div><h3 className="mt-3 text-sm font-bold text-foreground">{provider.name}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{provider.role}</p><p className="mt-3 border-t border-border/40 pt-3 text-[11px] leading-5 text-muted-foreground">{provider.detail}</p></article>)}</div>
      </section>

      <section className={cn("grid items-stretch gap-5", data.recentRuns.length ? "xl:grid-cols-[minmax(0,1fr)_420px]" : "xl:grid-cols-2")}>
        <div className="flex flex-col gap-4">
          <ResearchSectionHeader eyebrow="RUN HISTORY" title="生成运行历史" description="每次运行都保留状态、类型、提供方模式、耗时和失败原因。" />
          {data.recentRuns.length ? <div className="space-y-2">{data.recentRuns.map((run) => {
            const duration = run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : null;
            return <article key={run.id} className="rounded-xl border border-border/60 bg-card p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><TimerReset className="h-4 w-4" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-bold text-foreground">{run.runType}</p><ResearchStatusBadge status={run.status} /><Badge variant="outline" className="text-[10px] text-muted-foreground">{run.providerMode}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{formatResearchTime(run.startedAt, true)} → {formatResearchTime(run.finishedAt)}</p>{run.error && <p className="mt-2 text-xs leading-5 text-red-500">{run.error}</p>}</div><p className="text-xs font-semibold text-muted-foreground">{duration == null ? "进行中" : `${(duration / 1000).toFixed(1)}s`}</p></div></article>;
          })}</div> : <EmptyState icon={<Activity className="h-5 w-5" />} title="暂无运行历史" description="生成首份日报后，这里会记录运行类型、耗时和结果。" className="flex-1 rounded-xl border border-border/60 bg-card py-10 sm:py-12" />}
        </div>

        <div className="flex flex-col gap-4">
          <ResearchSectionHeader eyebrow="DELIVERY" title="推送通道与回执" description="真实通道和模拟推送均保留可审计记录。" />
          <div className="space-y-3">{data.notificationChannels.map((channel) => <article key={channel.id} className="rounded-xl border border-border/60 bg-card p-4"><div className="flex items-start justify-between gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500"><Bell className="h-4 w-4" /></span><ResearchStatusBadge status={channel.status} label={channel.isDryRun ? "Dry-run" : undefined} /></div><h3 className="mt-3 text-sm font-bold text-foreground">{channel.name}</h3><p className="mt-1 text-xs text-muted-foreground">{channel.channelType} · {channel.target ?? "未配置目标"}</p><p className="mt-3 text-[10px] text-muted-foreground">更新于 {formatResearchTime(channel.updatedAt)}</p></article>)}</div>
          {data.recentDeliveries.length ? <div className="space-y-2">{data.recentDeliveries.map((delivery) => <article key={delivery.id} className="rounded-xl border border-border/60 bg-card p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="line-clamp-1 text-sm font-semibold text-foreground">{delivery.title}</p><p className="mt-1 text-xs text-muted-foreground">{delivery.channelType} · {formatResearchTime(delivery.deliveredAt ?? delivery.createdAt)}</p></div><ResearchStatusBadge status={delivery.status} /></div>{delivery.error && <p className="mt-2 text-xs leading-5 text-red-500">{delivery.error}</p>}</article>)}</div> : <div className="rounded-xl border border-dashed border-border bg-card p-5 text-sm text-muted-foreground">暂无推送回执。</div>}
        </div>
      </section>
    </div>
  );
}
