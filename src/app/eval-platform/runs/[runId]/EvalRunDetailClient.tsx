"use client";

import Link from 'next/link';
import {
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  FileJson,
  FileText,
  Image as ImageIcon,
  Layers3,
  ListChecks,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/PageHeader';
import type { QuantEvalRun, QuantEvalResult, EvalCheckStatus } from '@/lib/eval';

type Props = {
  run: QuantEvalRun;
};

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(value: number) {
  if (!value) return '-';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`;
  return `${Math.round(value / 60_000)} 分钟`;
}

function statusClass(status: EvalCheckStatus) {
  switch (status) {
    case 'passed':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500';
    case 'warning':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-500';
    case 'failed':
      return 'border-red-500/25 bg-red-500/10 text-red-500';
    default:
      return 'border-border bg-muted/50 text-muted-foreground';
  }
}

function statusLabel(status: EvalCheckStatus) {
  switch (status) {
    case 'passed':
      return '通过';
    case 'warning':
      return '警告';
    case 'failed':
      return '失败';
    default:
      return '未知';
  }
}

function statusIcon(status: EvalCheckStatus) {
  if (status === 'passed') return <CheckCircle2 className="h-4 w-4" />;
  if (status === 'failed') return <XCircle className="h-4 w-4" />;
  if (status === 'warning') return <TriangleAlert className="h-4 w-4" />;
  return <ListChecks className="h-4 w-4" />;
}

function resultBorder(result: QuantEvalResult) {
  if (!result.passed) return 'border-red-500/25 bg-red-500/[0.035]';
  if (result.validationChecks.some((check) => check.status === 'warning')) {
    return 'border-amber-500/25 bg-amber-500/[0.025]';
  }
  return 'border-border/60 bg-card/90';
}

function scoreClass(score: number) {
  if (score >= 90) return 'text-emerald-500';
  if (score >= 75) return 'text-amber-500';
  return 'text-red-500';
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/65 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

export default function EvalRunDetailClient({ run }: Props) {
  const eventTotal = run.results.reduce((total, result) => total + (result.eventAudit?.total ?? 0), 0);
  const warnings = run.results.reduce(
    (total, result) =>
      total +
      result.validationChecks.filter((check) => check.status === 'warning').length +
      (result.eventAudit?.warningCount ?? 0),
    0
  );
  const errors = run.results.reduce((total, result) => total + (result.eventAudit?.errorCount ?? 0), 0);
  const skillEntries = Object.entries(run.metadata.skillLockSnapshot.skills);

  return (
    <div className="platform-shell">
      <PageHeader
        title="评测运行详情"
        backHref="/eval-platform?view=queue"
        badge={(
          <Badge className={run.passed ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500' : 'border-red-500/25 bg-red-500/10 text-red-500'}>
            {run.passed ? '通过' : '失败'}
          </Badge>
        )}
        subtitle={`${run.fileName} · ${formatDate(run.createdAt)} · ${run.metadata.suite?.label ?? '历史契约评测'}`}
      />

      <main className="platform-content mx-auto max-w-[1520px] px-3 py-5 sm:px-6 sm:py-7 lg:px-8">
        <section className="mb-5 overflow-hidden rounded-2xl border border-border/60 bg-card/90 p-5 shadow-[0_24px_60px_-42px_hsl(var(--shadow-color)/0.65)] sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[10px] font-bold tracking-[0.16em] text-primary">EVALUATION REPORT</p>
              <h1 className="mt-2 text-xl font-bold tracking-tight text-foreground sm:text-2xl">{run.fileName}</h1>
              <p className="mt-1 text-xs text-muted-foreground">{formatDate(run.createdAt)} · {run.metadata.suite?.label ?? '历史契约评测'} · {run.metadata.runtime.model ?? 'deterministic'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="bg-background/60">{run.total} 条用例</Badge>
              <Badge variant="outline" className="bg-background/60">并发 {run.metadata.evaluator.concurrency}</Badge>
              <Badge variant="outline" className="bg-background/60">重复 {run.metadata.selection.repeat} 次</Badge>
              <Badge variant="outline" className="bg-background/60">
                {run.metadata.evaluator.id ?? 'legacy'}@{run.metadata.evaluator.version ?? 'legacy'}
              </Badge>
              <Badge variant="outline" className="bg-background/60">{run.metadata.suite?.mode === 'e2e' ? '真实 Agent' : '确定性模板'}</Badge>
              <Badge variant="outline" className="bg-background/60">
                数据集 {run.metadata.dataset?.visibility ?? 'public'}{run.metadata.dataset?.promptsRedacted ? ' · prompt 已脱敏' : ''}
              </Badge>
              <Badge variant="outline" className="bg-background/60">
                Snapshot {run.metadata.dataSnapshots?.selected.length ?? 0}
              </Badge>
              <Badge className={run.passed ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500' : 'border-red-500/25 bg-red-500/10 text-red-500'}>{run.passed ? '质量门禁通过' : '质量门禁失败'}</Badge>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="border-border/60 bg-card/90">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <CheckCircle2 className="h-4 w-4" />
                通过率
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className={run.passRate === 100 ? 'text-2xl font-bold text-emerald-500' : 'text-2xl font-bold text-amber-500'}>
                {run.passRate}%
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{run.passedCount}/{run.total} 用例</p>
            </CardContent>
          </Card>
          <Card className="border-border/60 bg-card/90">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <CheckCircle2 className="h-4 w-4" />
                首轮通过率
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className={`text-2xl font-bold ${scoreClass(run.qualitySummary.firstPassRate)}`}>
                {run.qualitySummary.firstPassRate}%
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{run.qualitySummary.firstPassCount}/{run.total} 无修复通过</p>
            </CardContent>
          </Card>
          <Card className="border-border/60 bg-card/90">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <BarChart3 className="h-4 w-4" />
                平均分
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className={`text-2xl font-bold ${scoreClass(run.averageScore)}`}>{run.averageScore}</p>
              <p className="mt-1 text-xs text-muted-foreground">综合评分</p>
            </CardContent>
          </Card>
          <Card className="border-border/60 bg-card/90">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <TriangleAlert className="h-4 w-4" />
                修复率
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className={`text-2xl font-bold ${run.qualitySummary.repairRate === 0 ? 'text-emerald-500' : 'text-amber-500'}`}>
                {run.qualitySummary.repairRate}%
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{run.qualitySummary.repairedCaseCount} 条发生修复</p>
            </CardContent>
          </Card>
          <Card className="border-border/60 bg-card/90">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Layers3 className="h-4 w-4" />
                重复稳定率
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className={`text-2xl font-bold ${scoreClass(run.qualitySummary.stability.passRate)}`}>
                {run.qualitySummary.stability.passRate}%
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                95% CI {run.qualitySummary.stability.confidence95.lower}–{run.qualitySummary.stability.confidence95.upper}% · 最大分数 σ {run.qualitySummary.stability.scoreStdDev.max.value}
              </p>
            </CardContent>
          </Card>
          <Card className="border-border/60 bg-card/90">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Clock3 className="h-4 w-4" />
                P95 耗时
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-2xl font-bold text-foreground">{formatDuration(run.qualitySummary.durationMs.p95)}</p>
              <p className="mt-1 text-xs text-muted-foreground">累计 {formatDuration(run.durationMs)}</p>
            </CardContent>
          </Card>
          <Card className="border-border/60 bg-card/90">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Layers3 className="h-4 w-4" />
                事件
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-2xl font-bold text-foreground">{eventTotal}</p>
              <p className="mt-1 text-xs text-muted-foreground">过程事件</p>
            </CardContent>
          </Card>
          <Card className="col-span-2 border-border/60 bg-card/90 lg:col-span-1">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <TriangleAlert className="h-4 w-4" />
                告警/错误
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-2xl font-bold text-foreground">
                {warnings}/{errors}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">warning / error</p>
            </CardContent>
          </Card>
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[0.75fr_1.25fr]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <BarChart3 className="h-5 w-5 text-red-600" />
                覆盖矩阵
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <p className="mb-3 text-sm font-semibold text-slate-700">能力覆盖</p>
                <div className="space-y-2">
                  {Object.entries(run.coverage.byCapability).map(([capability, item]) => {
                    const rate = item.total ? Math.round((item.passed / item.total) * 100) : 0;
                    return (
                      <div key={capability} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-mono text-sm text-slate-700">{capability}</span>
                          <span className={rate === 100 ? 'font-semibold text-emerald-600' : 'font-semibold text-amber-600'}>
                            {item.passed}/{item.total}
                          </span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={rate === 100 ? 'h-full rounded-full bg-emerald-500' : 'h-full rounded-full bg-amber-500'}
                            style={{ width: `${rate}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="mb-3 text-sm font-semibold text-slate-700">必要覆盖项</p>
                <div className="flex flex-wrap gap-2">
                  {run.coverage.requiredCoverage.capabilities.map((item) => (
                    <Badge key={item} variant="outline" className="bg-white font-mono">
                      {item}
                    </Badge>
                  ))}
                  {run.coverage.requiredCoverage.tags.map((item) => (
                    <Badge key={item} className="border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-50">
                      {item}
                    </Badge>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-3 text-sm font-semibold text-slate-700">分层覆盖</p>
                <div className="space-y-3">
                  {Object.entries(run.coverage.byLevel).map(([level, capabilities]) => (
                    <div key={level} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="font-mono text-xs font-semibold text-slate-700">{level}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {Object.entries(capabilities).map(([capability, item]) => (
                          <Badge key={`${level}-${capability}`} variant="outline" className="bg-white font-mono text-[10px]">
                            {capability} {item.passed}/{item.total}
                          </Badge>
                        ))}
                        {!Object.keys(capabilities).length && <span className="text-xs text-slate-500">本次运行未覆盖</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-3 text-sm font-semibold text-slate-700">报告文件</p>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-sm text-slate-700">
                  {run.filePath}
                </div>
              </div>

              <div>
                <p className="mb-3 text-sm font-semibold text-slate-700">运行配置</p>
                <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-500">CLI / 模型</span>
                    <span className="font-mono">{run.metadata.runtime.cli ?? '-'} / {run.metadata.runtime.model ?? '-'}</span>
                  </div>
                  {run.metadata.runtime.reasoningEffort && (
                    <div className="flex justify-between gap-3">
                      <span className="text-slate-500">Reasoning</span>
                      <span className="font-mono">{run.metadata.runtime.reasoningEffort}</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-500">触发来源</span>
                    <span className="font-mono">{run.metadata.trigger ?? '-'}</span>
                  </div>
                </div>
              </div>

              <div>
                <p className="mb-3 text-sm font-semibold text-slate-700">Skill 快照</p>
                <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
                  {skillEntries.map(([skillId, entry]) => (
                    <div key={skillId} className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-sm">
                      <span className="truncate font-mono text-slate-700">{skillId}</span>
                      <Badge variant="outline" className="shrink-0 bg-white">
                        v{entry.version ?? 'unknown'}
                      </Badge>
                    </div>
                  ))}
                  {!skillEntries.length && (
                    <p className="text-sm text-slate-500">此报告没有 skill lock 快照。重新运行 benchmark 后会自动写入。</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            {run.results.map((result) => (
              <Card key={result.id} id={`case-${result.id}`} className={resultBorder(result)}>
                <CardHeader>
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-xl">{result.name}</CardTitle>
                        <Badge className={result.passed ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}>
                          {result.passed ? '通过' : '失败'}
                        </Badge>
                        <Badge variant="outline" className="bg-white">
                          {result.capabilityLabel}
                        </Badge>
                        <Badge className={result.firstPassPassed ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}>
                          {result.firstPassPassed ? '首轮通过' : `修复 ${result.repairAttempts} 次`}
                        </Badge>
                      </div>
                      <p className="mt-2 text-sm text-slate-500">{result.question}</p>
                    </div>
                    <div className="text-left md:text-right">
                      <p className={`text-2xl font-bold ${scoreClass(result.score)}`}>{result.score}</p>
                      <p className="text-xs text-slate-500">{formatDuration(result.durationMs)}</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  {result.failures.length > 0 && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                      <p className="mb-2 font-semibold text-red-800">失败原因</p>
                      <ul className="space-y-1 text-sm text-red-700">
                        {result.failures.map((failure) => (
                          <li key={failure}>- {failure}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="grid gap-3 md:grid-cols-4">
                    <Metric label="标的" value={result.symbols.length ? result.symbols.join(', ') : '-'} />
                    <Metric label="模板" value={result.artifacts.templateId ?? '-'} />
                    <Metric label="原始文件" value={result.artifacts.rawFileCount} />
                    <Metric label="质量状态" value={result.artifacts.qualityStatus ?? '-'} />
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <Metric label="K 线行数" value={result.artifacts.klineRows} />
                    <Metric label="财报行数" value={result.artifacts.reportRows} />
                    <Metric label="公告行数" value={result.artifacts.announcementRows} />
                    <Metric label="交易行数" value={result.artifacts.tradeRows} />
                    <Metric label="持仓数量" value={result.artifacts.holdingCount} />
                    <Metric label="对比行数" value={result.artifacts.comparisonRows} />
                  </div>

                  {result.evaluation && (
                    <div className="rounded-lg border border-slate-200 bg-white p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="font-semibold text-slate-950">质量维度</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {result.evaluation.evaluatorId}@{result.evaluation.evaluatorVersion} · {result.evaluation.rubricVersion}
                          </p>
                        </div>
                        <Badge className={result.evaluation.passed ? statusClass('passed') : statusClass('failed')}>
                          {result.evaluation.passed ? '评测通过' : '评测失败'}
                        </Badge>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        {result.evaluation.dimensions.map((dimension) => (
                          <div key={dimension.id} className="rounded-md border border-slate-100 bg-slate-50 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-medium text-slate-600">{dimension.label} · {dimension.weight}%</span>
                              <span className={`font-mono text-sm font-bold ${scoreClass(dimension.score)}`}>{dimension.score}</span>
                            </div>
                            <p className="mt-2 text-[11px] leading-4 text-slate-500">{dimension.summary}</p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 space-y-2">
                        {result.evaluation.checks.map((check) => (
                          <div key={check.id} className="flex items-start justify-between gap-3 rounded-md border border-slate-100 px-3 py-2 text-xs">
                            <div><span className="font-semibold text-slate-800">{check.name}</span><p className="mt-0.5 text-slate-500">{check.summary}</p></div>
                            <Badge className={statusClass(check.status)}>{statusLabel(check.status)}</Badge>
                          </div>
                        ))}
                      </div>
                      {result.evaluation.semanticReview && (
                        <div className="mt-3 rounded-md border border-violet-200 bg-violet-50 p-3">
                          <p className="text-xs font-semibold text-violet-800">语义审阅 · {result.evaluation.semanticReview.score}</p>
                          <p className="mt-1 text-xs leading-5 text-violet-700">{result.evaluation.semanticReview.summary}</p>
                          <p className="mt-2 text-[10px] text-violet-600">
                            {result.evaluation.semanticReview.reviewer.model} · {result.evaluation.semanticReview.reviewer.promptVersion} · 与生成模型{result.evaluation.semanticReview.reviewer.independentFromGenerator ? '独立' : '同源'}
                          </p>
                          {result.evaluation.semanticReview.usage && (
                            <p className="mt-1 text-[10px] tabular-nums text-violet-600">
                              reviewer tokens：{result.evaluation.semanticReview.usage.inputTokens} 输入 / {result.evaluation.semanticReview.usage.outputTokens} 输出 / {result.evaluation.semanticReview.usage.totalTokens} 总计
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {result.stability && result.stability.repeatCount > 1 && (
                    <div className="rounded-lg border border-slate-200 bg-white p-4">
                      <p className="font-semibold text-slate-950">重复运行稳定性</p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {result.stability.attempts.map((attempt) => (
                          <div key={attempt.attempt} className="rounded-md border border-slate-100 bg-slate-50 p-3 text-xs">
                            <div className="flex justify-between"><span>第 {attempt.attempt} 次</span><strong className={attempt.passed ? 'text-emerald-600' : 'text-red-600'}>{attempt.passed ? '通过' : '失败'}</strong></div>
                            <p className="mt-1 text-slate-500">得分 {attempt.score} · 修复 {attempt.repairAttempts} · {formatDuration(attempt.durationMs)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.traceDiagnostics && (
                    <div className="rounded-lg border border-slate-200 bg-white p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold text-slate-950">过程级故障归因</p>
                        <Badge className={result.traceDiagnostics.primaryFailureStage ? statusClass('failed') : statusClass('passed')}>
                          {result.traceDiagnostics.primaryFailureStage
                            ? `首要失败：${result.traceDiagnostics.primaryFailureStage}`
                            : '可观察链路正常'}
                        </Badge>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        {result.traceDiagnostics.stages.map((stage) => (
                          <div key={stage.id} className="rounded-md border border-slate-100 bg-slate-50 p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-800">{stage.label}</span>
                              <Badge className={statusClass(stage.status)}>{statusLabel(stage.status)}</Badge>
                            </div>
                            <p className="mt-2 line-clamp-2 text-[11px] text-slate-500">
                              {stage.signals.join(' · ') || '无额外信号'}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-lg border border-slate-200 bg-white p-4">
                      <div className="mb-3 flex items-center gap-2 font-semibold text-slate-950">
                        <ListChecks className="h-4 w-4 text-red-600" />
                        验证项
                      </div>
                      <div className="space-y-2">
                        {result.validationChecks.map((check) => (
                          <div key={`${result.id}-${check.id}`} className="rounded-md border border-slate-100 bg-slate-50 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-medium text-slate-900">{check.name}</span>
                              <Badge className={statusClass(check.status)}>
                                {statusIcon(check.status)}
                                <span className="ml-1">{statusLabel(check.status)}</span>
                              </Badge>
                            </div>
                            {check.summary && <p className="mt-2 text-sm text-slate-500">{check.summary}</p>}
                          </div>
                        ))}
                        {!result.validationChecks.length && (
                          <p className="text-sm text-slate-500">没有验证项。</p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-white p-4">
                      <div className="mb-3 flex items-center gap-2 font-semibold text-slate-950">
                        <Database className="h-4 w-4 text-red-600" />
                        事件与产物
                      </div>
                      <div className="space-y-3">
                        <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">final 数据文件</p>
                          <p className="mt-1 break-all font-mono text-sm text-slate-900">
                            {result.artifacts.finalDataPath ?? '-'}
                          </p>
                        </div>
                        <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">事件类型</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(result.eventAudit?.eventTypes ?? []).map((eventType) => (
                              <Badge key={eventType} variant="outline" className="bg-white font-mono">
                                {eventType}
                              </Badge>
                            ))}
                            {!result.eventAudit?.eventTypes.length && <span className="text-sm text-slate-500">-</span>}
                          </div>
                        </div>
                        <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">阶段</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(result.eventAudit?.stages ?? []).map((stage) => (
                              <Badge key={stage} className="border-slate-200 bg-white text-slate-700 hover:bg-white">
                                {stage}
                              </Badge>
                            ))}
                            {!result.eventAudit?.stages.length && <span className="text-sm text-slate-500">-</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {result.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="bg-white">
                        {tag}
                      </Badge>
                    ))}
                    {result.visualCheck && (
                      <Badge className={result.visualCheck.passed ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}>
                        <ImageIcon className="mr-1 h-3.5 w-3.5" />
                        截图 {result.visualCheck.passed ? '通过' : '失败'}
                      </Badge>
                    )}
                    {result.visualCheck && (
                      <Badge variant="outline" className="bg-white">
                        {result.visualCheck.screenshots.length} 个视口 · 可访问性问题 {result.visualCheck.accessibilityIssueCount}
                      </Badge>
                    )}
                    {result.artifacts.hasImageExtraction && (
                      <Badge className="border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-50">
                        图片识别证据
                      </Badge>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                    {result.projectId && (
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/${result.projectId}/chat`}>
                          <ExternalLink className="h-4 w-4" />
                          项目
                        </Link>
                      </Button>
                    )}
                    {result.projectPath && (
                      <Button variant="outline" size="sm" disabled>
                        <FileText className="h-4 w-4" />
                        {result.projectPath.split('/').slice(-1)[0]}
                      </Button>
                    )}
                    {result.artifacts.finalDataPath && (
                      <Button variant="outline" size="sm" disabled>
                        <FileJson className="h-4 w-4" />
                        dashboard-data.json
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
