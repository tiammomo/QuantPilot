import Link from 'next/link';
import { Activity, ChevronRight, Clock3, Loader2, Settings2, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCompactDate as formatDate } from '@/components/quant/console-primitives';
import { CLI_LABELS, Panel, queueBadge, selectClassName } from '@/components/quant/eval-console-primitives';
import type { QuantEvalCase, QuantEvalQueueItem, QuantEvalRuntimeOption, QuantEvalScheduleConfig } from '@/lib/quant/evals';

type EvalQueueViewProps = {
  queue: QuantEvalQueueItem[];
  schedule: QuantEvalScheduleConfig;
  cases: QuantEvalCase[];
  runtimeOptions: QuantEvalRuntimeOption[];
  scheduleRuntime: QuantEvalRuntimeOption;
  scheduleRuntimeSupportsReasoning: boolean;
  scheduleEnabled: boolean;
  scheduleInterval: string;
  scheduleCli: string;
  scheduleModel: string;
  scheduleReasoningEffort: string;
  scheduleCase: string;
  isSavingSchedule: boolean;
  onCancelBenchmark: (queueId: string) => void;
  onScheduleEnabledChange: (enabled: boolean) => void;
  onScheduleIntervalChange: (interval: string) => void;
  onScheduleCliChange: (cli: string) => void;
  onScheduleModelChange: (model: string) => void;
  onScheduleReasoningEffortChange: (effort: string) => void;
  onScheduleCaseChange: (caseId: string) => void;
  onSaveSchedule: () => void;
};

export function EvalQueueView({
  queue,
  schedule,
  cases,
  runtimeOptions,
  scheduleRuntime,
  scheduleRuntimeSupportsReasoning,
  scheduleEnabled,
  scheduleInterval,
  scheduleCli,
  scheduleModel,
  scheduleReasoningEffort,
  scheduleCase,
  isSavingSchedule,
  onCancelBenchmark,
  onScheduleEnabledChange,
  onScheduleIntervalChange,
  onScheduleCliChange,
  onScheduleModelChange,
  onScheduleReasoningEffortChange,
  onScheduleCaseChange,
  onSaveSchedule,
}: EvalQueueViewProps) {
  const activeCount = queue.filter((item) => item.status === 'queued' || item.status === 'running').length;
  const title = activeCount > 0 ? '运行中' : '运行历史';

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Panel
        title={title}
        icon={<Activity className="h-4 w-4 text-amber-400" />}
        action={
          <Badge variant="outline" className="text-muted-foreground border-border/40">
            {activeCount > 0 ? activeCount : queue.length}
          </Badge>
        }
      >
        <div id="queue" className="divide-y divide-border/30">
          {queue.map((item) => (
            <div key={item.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {queueBadge(item.status)}
                    <span className="truncate font-mono text-xs text-muted-foreground">{item.id}</span>
                  </div>
                  <p className="mt-2 truncate text-sm font-medium text-foreground">
                    {CLI_LABELS[item.cli] ?? item.cli} · {item.model}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    创建 {formatDate(item.createdAt)} · 开始 {formatDate(item.startedAt)} · 结束 {formatDate(item.finishedAt)}
                  </p>
                  {item.error && <p className="mt-2 text-xs text-red-400">{item.error}</p>}
                </div>
                {item.reportId ? (
                  <Button variant="ghost" size="icon" asChild>
                    <Link href={`/eval-platform/runs/${item.reportId}`} aria-label="查看报告">
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </Button>
                ) : item.status === 'running' || item.status === 'queued' ? (
                  <Button variant="ghost" size="icon" onClick={() => onCancelBenchmark(item.id)} aria-label="取消">
                    <Square className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {!queue.length && <div className="p-8 text-center text-sm text-muted-foreground">暂无运行历史。</div>}
        </div>
      </Panel>

      <Panel title="定时回归" icon={<Clock3 className="h-4 w-4 text-primary" />}>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2">
            <select className={selectClassName} value={scheduleEnabled ? 'enabled' : 'disabled'} onChange={(event) => onScheduleEnabledChange(event.target.value === 'enabled')}>
              <option value="enabled">启用</option>
              <option value="disabled">停用</option>
            </select>
            <select className={selectClassName} value={scheduleInterval} onChange={(event) => onScheduleIntervalChange(event.target.value)}>
              <option value="6">6 小时</option>
              <option value="12">12 小时</option>
              <option value="24">24 小时</option>
              <option value="72">3 天</option>
              <option value="168">7 天</option>
            </select>
            <select className={selectClassName} value={scheduleCli} onChange={(event) => onScheduleCliChange(event.target.value)}>
              {runtimeOptions.map((runtime) => (
                <option key={runtime.cli} value={runtime.cli}>
                  {runtime.label}
                </option>
              ))}
            </select>
            <select className={selectClassName} value={scheduleModel} onChange={(event) => onScheduleModelChange(event.target.value)}>
              {scheduleRuntime.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
          {scheduleRuntimeSupportsReasoning && (
            <select
              className={selectClassName}
              value={scheduleReasoningEffort}
              onChange={(event) => onScheduleReasoningEffortChange(event.target.value)}
            >
              <option value="low">reasoning low</option>
              <option value="medium">reasoning medium</option>
              <option value="high">reasoning high</option>
              <option value="xhigh">reasoning xhigh</option>
            </select>
          )}
          <select className={selectClassName} value={scheduleCase} onChange={(event) => onScheduleCaseChange(event.target.value)}>
            <option value="all">全部用例</option>
            {cases.map((testCase) => (
              <option key={testCase.id} value={testCase.id}>
                {testCase.name}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-border/30 bg-card/40 p-3">
              <p className="text-muted-foreground">下次触发</p>
              <p className="mt-1 font-medium text-foreground">{formatDate(schedule.nextRunAt)}</p>
            </div>
            <div className="rounded-lg border border-border/30 bg-card/40 p-3">
              <p className="text-muted-foreground">上次触发</p>
              <p className="mt-1 font-medium text-foreground">{formatDate(schedule.lastRunAt)}</p>
            </div>
          </div>
          <Button onClick={onSaveSchedule} disabled={isSavingSchedule} className="w-full">
            {isSavingSchedule ? <Loader2 className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
            保存配置
          </Button>
        </div>
      </Panel>
    </section>
  );
}
