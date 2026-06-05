"use client";

import Link from 'next/link';
import {
  ArrowLeft,
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
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'warning':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
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
  if (!result.passed) return 'border-red-200 bg-red-50/30';
  if (result.validationChecks.some((check) => check.status === 'warning')) {
    return 'border-amber-200 bg-amber-50/20';
  }
  return 'border-slate-200 bg-white';
}

function scoreClass(score: number) {
  if (score >= 90) return 'text-emerald-600';
  if (score >= 75) return 'text-amber-600';
  return 'text-red-600';
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-slate-950">{value}</p>
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
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" asChild>
              <Link href="/eval-platform" aria-label="返回评测平台">
                <ArrowLeft className="h-5 w-5" />
              </Link>
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-red-600" />
                <h1 className="text-2xl font-bold tracking-normal text-slate-950">评测运行详情</h1>
                <Badge className={run.passed ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}>
                  {run.passed ? '通过' : '失败'}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {run.fileName} · {formatDate(run.createdAt)} · {run.metadata.runtime.cli ?? 'unknown'} / {run.metadata.runtime.model ?? 'unknown'}
              </p>
            </div>
          </div>
          <Button variant="outline" asChild>
            <Link href="/eval-platform">返回总览</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <section className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                <CheckCircle2 className="h-4 w-4" />
                通过率
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={run.passRate === 100 ? 'text-3xl font-bold text-emerald-600' : 'text-3xl font-bold text-amber-600'}>
                {run.passRate}%
              </p>
              <p className="mt-1 text-sm text-slate-500">{run.passedCount}/{run.total} 用例</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                <BarChart3 className="h-4 w-4" />
                平均分
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-3xl font-bold ${scoreClass(run.averageScore)}`}>{run.averageScore}</p>
              <p className="mt-1 text-sm text-slate-500">粗评分</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                <Clock3 className="h-4 w-4" />
                总耗时
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-slate-950">{formatDuration(run.durationMs)}</p>
              <p className="mt-1 text-sm text-slate-500">用例累计</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                <Layers3 className="h-4 w-4" />
                事件
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-slate-950">{eventTotal}</p>
              <p className="mt-1 text-sm text-slate-500">过程事件</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-500">
                <TriangleAlert className="h-4 w-4" />
                告警/错误
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-slate-950">
                {warnings}/{errors}
              </p>
              <p className="mt-1 text-sm text-slate-500">warning/error</p>
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
