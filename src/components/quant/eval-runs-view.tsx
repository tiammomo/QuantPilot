import Link from 'next/link';
import { BarChart3, CheckCircle2, ChevronRight, Database, Layers3, Search, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCompactDate as formatDate } from '@/components/quant/console-primitives';
import {
  CLI_LABELS,
  Panel,
  formatDuration,
  passRateClass,
  scoreClass,
} from '@/components/quant/eval-console-primitives';
import type { QuantEvalModelComparison, QuantEvalRun, QuantEvalSkillVersionImpact } from '@/lib/eval';

type EvalRunsViewProps = {
  runKeyword: string;
  filteredRuns: QuantEvalRun[];
  modelComparison: QuantEvalModelComparison[];
  skillVersionImpact: QuantEvalSkillVersionImpact[];
  onRunKeywordChange: (keyword: string) => void;
};

export function EvalRunsView({
  runKeyword,
  filteredRuns,
  modelComparison,
  skillVersionImpact,
  onRunKeywordChange,
}: EvalRunsViewProps) {
  return (
    <>
      <Panel
        title="运行记录"
        icon={<Database className="h-4 w-4 text-primary" />}
        action={
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={runKeyword}
              onChange={(event) => onRunKeywordChange(event.target.value)}
              placeholder="搜索运行记录..."
              className="h-9 border-border/40 bg-card/60 pl-9 text-sm"
            />
          </div>
        }
      >
        <div id="runs" className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border/30 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-3">运行</th>
                <th className="px-4 py-3">模型</th>
                <th className="px-4 py-3">通过率</th>
                <th className="px-4 py-3">平均分</th>
                <th className="px-4 py-3">耗时</th>
                <th className="px-4 py-3 text-right">详情</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.map((run) => (
                <tr key={run.id} className="border-b border-border/20 transition-colors hover:bg-muted/20">
                  <td className="min-w-0 px-4 py-3">
                    <div className="flex items-center gap-2">
                      {run.passed ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-400" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-foreground/80">{run.fileName}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{formatDate(run.createdAt)}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground/80">
                    {run.metadata.runtime.cli} · {run.metadata.runtime.model}
                  </td>
                  <td className={`px-4 py-3 font-semibold ${passRateClass(run.passRate)}`}>{run.passRate}%</td>
                  <td className={`px-4 py-3 font-semibold ${scoreClass(run.averageScore)}`}>{run.averageScore}</td>
                  <td className="px-4 py-3 text-foreground/80">{formatDuration(run.durationMs)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="icon" asChild className="h-7 w-7">
                      <Link href={`/eval-platform/runs/${run.id}`} aria-label="查看详情">
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
              {!filteredRuns.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    没有匹配的运行记录。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="grid gap-5 xl:grid-cols-2">
        <Panel title="模型对比" icon={<Layers3 className="h-4 w-4 text-primary" />}>
          <div className="divide-y divide-border/30">
            {modelComparison.slice(0, 6).map((item) => (
              <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_72px_72px_auto] items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {CLI_LABELS[item.cli] ?? item.cli} · {item.model}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{item.runs} 次运行</p>
                </div>
                <span className={`font-semibold ${passRateClass(item.latestPassRate)}`}>{item.latestPassRate}%</span>
                <span className={`font-semibold ${scoreClass(item.averageScore)}`}>{item.averageScore}</span>
                <Button variant="ghost" size="icon" asChild className="h-7 w-7">
                  <Link href={`/eval-platform/runs/${item.latestRunId}`} aria-label="查看最新模型报告">
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            ))}
            {!modelComparison.length && <div className="p-8 text-center text-sm text-muted-foreground">暂无模型对比数据。</div>}
          </div>
        </Panel>

        <Panel title="Skill 版本影响" icon={<BarChart3 className="h-4 w-4 text-emerald-400" />}>
          <div className="max-h-[340px] overflow-y-auto divide-y divide-border/30">
            {skillVersionImpact.slice(0, 8).map((item) => (
              <div key={`${item.skillId}@${item.version}`} className="grid grid-cols-[minmax(0,1fr)_72px_72px] items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-mono font-medium text-foreground">{item.skillId}</p>
                  <p className="mt-1 text-xs text-muted-foreground">v{item.version} · {item.runs} 次运行</p>
                </div>
                <span className={`font-semibold ${passRateClass(item.latestPassRate)}`}>{item.latestPassRate}%</span>
                <span className={`font-semibold ${scoreClass(item.averageScore)}`}>{item.averageScore}</span>
              </div>
            ))}
            {!skillVersionImpact.length && <div className="p-8 text-center text-sm text-muted-foreground">暂无 skill 快照数据。</div>}
          </div>
        </Panel>
      </section>
    </>
  );
}
