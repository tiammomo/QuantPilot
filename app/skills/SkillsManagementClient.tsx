"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  FileText,
  GitBranch,
  PackageCheck,
  Search,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { SkillHealthStatus, SkillsDashboardData } from '@/lib/quant/skills-dashboard';

type SkillsPayload = SkillsDashboardData;

const statusLabels: Record<SkillHealthStatus, string> = {
  ok: '正常',
  warning: '需同步',
  error: '异常',
};

const statusStyles: Record<SkillHealthStatus, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  error: 'border-red-200 bg-red-50 text-red-700',
};

function formatBytes(value: number): string {
  if (!value) return '-';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatTime(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function pillClass(status: SkillHealthStatus) {
  return `inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusStyles[status]}`;
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      {children}
    </Card>
  );
}

function ListBlock({ items, empty = '暂无' }: { items: string[]; empty?: string }) {
  if (!items.length) {
    return <p className="text-sm text-gray-400">{empty}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={item} variant="outline" className="font-normal text-muted-foreground">
          {item}
        </Badge>
      ))}
    </div>
  );
}

export default function SkillsManagementClient({ initialData }: { initialData: SkillsPayload }) {
  const payload = initialData;
  const [selectedId, setSelectedId] = useState<string | null>(initialData.skills[0]?.id ?? null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | SkillHealthStatus>('all');

  const filteredSkills = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return payload.skills.filter((skill) => {
      if (filter !== 'all' && skill.health.status !== filter) return false;
      if (!keyword) return true;
      return [
        skill.id,
        skill.name,
        skill.version,
        skill.status,
        skill.boundary,
        ...skill.inputs,
        ...skill.outputs,
        ...skill.scripts,
        ...skill.legacyAliases,
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [payload.skills, query, filter]);

  const selectedSkill =
    filteredSkills.find((skill) => skill.id === selectedId) ??
    payload.skills.find((skill) => skill.id === selectedId) ??
    filteredSkills[0] ??
    null;

  useEffect(() => {
    if (!selectedSkill && filteredSkills[0]) {
      setSelectedId(filteredSkills[0].id);
    }
  }, [filteredSkills, selectedSkill]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:px-6">
        <Card className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <Link href="/" className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary">
              <ArrowLeft className="h-4 w-4" />
              返回首页
            </Link>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-md bg-primary text-lg font-bold text-primary-foreground">
                Q
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-normal">Skills 管理</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  统一查看核心 skill 的版本、变更记录、压缩包和锁文件状态。
                </p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center sm:min-w-[360px]">
            <div className="rounded-md border bg-muted/40 px-3 py-2">
              <div className="text-xl font-bold">{payload.totals.total}</div>
              <div className="text-xs text-muted-foreground">核心技能</div>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="text-xl font-bold text-emerald-700">{payload.totals.ok}</div>
              <div className="text-xs text-emerald-700">正常</div>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-xl font-bold text-amber-700">{payload.totals.warning + payload.totals.error}</div>
              <div className="text-xs text-amber-700">待处理</div>
            </div>
          </div>
        </Card>

        <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="rounded-lg border bg-card text-card-foreground">
            <div className="border-b p-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索 skill、脚本或输出..."
                  className="pl-9"
                />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-1.5">
                {(['all', 'ok', 'warning', 'error'] as const).map((item) => (
                  <Button
                    key={item}
                    type="button"
                    onClick={() => setFilter(item)}
                    size="sm"
                    variant={filter === item ? 'default' : 'secondary'}
                    className="h-8 px-2"
                  >
                    {item === 'all' ? '全部' : statusLabels[item]}
                  </Button>
                ))}
              </div>
            </div>

            <div className="max-h-[calc(100vh-260px)] overflow-y-auto p-2">
              {filteredSkills.map((skill) => {
                const active = selectedSkill?.id === skill.id;
                return (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => setSelectedId(skill.id)}
                    className={`w-full rounded-lg border p-3 text-left transition-colors ${
                      active
                        ? 'border-primary/20 bg-primary/10'
                        : 'border-transparent hover:border-border hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold">{skill.name}</div>
                        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{skill.id}</div>
                      </div>
                      <span className={pillClass(skill.health.status)}>{statusLabels[skill.health.status]}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>v{skill.version}</span>
                      <span>•</span>
                      <span>{skill.status}</span>
                      <span>•</span>
                      <span>{skill.source.fileCount} 文件</span>
                    </div>
                  </button>
                );
              })}
              {filteredSkills.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-gray-400">没有匹配的 skill</div>
              )}
            </div>
          </aside>

          {selectedSkill ? (
            <main className="space-y-5">
              <section className="rounded-lg border border-gray-200 bg-white p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-bold tracking-normal text-gray-950">{selectedSkill.name}</h2>
                      <span className={pillClass(selectedSkill.health.status)}>
                        {selectedSkill.health.status === 'ok' ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <TriangleAlert className="mr-1 h-3.5 w-3.5" />}
                        {statusLabels[selectedSkill.health.status]}
                      </span>
                      <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-semibold text-gray-600">
                        v{selectedSkill.version}
                      </span>
                    </div>
                    <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-600">{selectedSkill.boundary}</p>
                  </div>
                  <div className="grid min-w-[220px] grid-cols-2 gap-2 text-sm">
                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">源码文件</div>
                      <div className="mt-1 font-semibold text-gray-950">{selectedSkill.source.fileCount}</div>
                    </div>
                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">包大小</div>
                      <div className="mt-1 font-semibold text-gray-950">{formatBytes(selectedSkill.package.size)}</div>
                    </div>
                  </div>
                </div>

                {selectedSkill.health.missing.length > 0 && (
                  <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    需要处理：{selectedSkill.health.missing.join('、')}。通常运行 `npm run package:skills -- {selectedSkill.id}` 后再执行 `npm run check:skills`。
                  </div>
                )}
              </section>

              <div className="grid gap-5 xl:grid-cols-2">
                <Section title="输入与输出" icon={<GitBranch className="h-4 w-4" />}>
                  <div className="space-y-4">
                    <div>
                      <div className="mb-2 text-xs font-semibold text-gray-400">输入</div>
                      <ListBlock items={selectedSkill.inputs} />
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-semibold text-gray-400">输出</div>
                      <ListBlock items={selectedSkill.outputs} />
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-semibold text-gray-400">接口</div>
                      <ListBlock items={selectedSkill.endpoints} />
                    </div>
                  </div>
                </Section>

                <Section title="脚本与引用" icon={<Wrench className="h-4 w-4" />}>
                  <div className="space-y-4">
                    <div>
                      <div className="mb-2 text-xs font-semibold text-gray-400">脚本</div>
                      <ListBlock items={selectedSkill.scripts} empty="没有脚本" />
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <div className="text-xs text-gray-500">references</div>
                        <div className="mt-1 font-semibold text-gray-950">{selectedSkill.source.hasReferences ? '已接入' : '未使用'}</div>
                      </div>
                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <div className="text-xs text-gray-500">scripts</div>
                        <div className="mt-1 font-semibold text-gray-950">{selectedSkill.source.hasScripts ? '已接入' : '未使用'}</div>
                      </div>
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-semibold text-gray-400">兼容别名</div>
                      <ListBlock items={selectedSkill.legacyAliases} empty="没有 legacy alias" />
                    </div>
                  </div>
                </Section>
              </div>

              <Section title="版本变更" icon={<BookOpen className="h-4 w-4" />}>
                {selectedSkill.changelog.currentRelease ? (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-gray-950 px-2 py-1 text-xs font-semibold text-white">
                        v{selectedSkill.changelog.currentRelease.version}
                      </span>
                      <span className="text-xs text-gray-500">{selectedSkill.changelog.currentRelease.date}</span>
                    </div>
                    <p className="mt-3 text-sm font-medium text-gray-950">{selectedSkill.changelog.currentRelease.summary}</p>
                    <ul className="mt-3 space-y-2 text-sm text-gray-600">
                      {selectedSkill.changelog.currentRelease.changes.map((change) => (
                        <li key={change} className="flex gap-2">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                          <span>{change}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    当前版本缺少 changelog release。
                  </div>
                )}
              </Section>

              <div className="grid gap-5 xl:grid-cols-2">
                <Section title="源码与 Lock" icon={<FileText className="h-4 w-4" />}>
                  <dl className="space-y-3 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">源码目录</dt>
                      <dd className="truncate font-mono text-gray-950">{selectedSkill.source.path}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">SKILL.md</dt>
                      <dd className="truncate font-mono text-gray-950">{selectedSkill.source.skillFilePath}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">源码 hash</dt>
                      <dd className="font-mono text-gray-950">{selectedSkill.source.sourceSha256Short}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">Lock 版本</dt>
                      <dd className="font-mono text-gray-950">{selectedSkill.lock.version ?? '-'}</dd>
                    </div>
                  </dl>
                </Section>

                <Section title="压缩包" icon={<Archive className="h-4 w-4" />}>
                  <dl className="space-y-3 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">状态</dt>
                      <dd className="font-semibold text-gray-950">{selectedSkill.package.exists ? '已生成' : '缺失'}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">路径</dt>
                      <dd className="truncate font-mono text-gray-950">{selectedSkill.package.path}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">更新时间</dt>
                      <dd className="font-mono text-gray-950">{formatTime(selectedSkill.package.updatedAt)}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">包 hash</dt>
                      <dd className="font-mono text-gray-950">{selectedSkill.package.packageSha256Short ?? '-'}</dd>
                    </div>
                  </dl>
                </Section>
              </div>

              <Section title="验证规则" icon={<ShieldCheck className="h-4 w-4" />}>
                <ListBlock items={selectedSkill.validation} />
              </Section>

              <section className="rounded-lg border border-gray-200 bg-white p-5">
                <div className="mb-4 flex items-center gap-2">
                  <PackageCheck className="h-4 w-4 text-gray-500" />
                  <h2 className="text-base font-semibold text-gray-950">建议操作</h2>
                </div>
                <div className="grid gap-3 text-sm md:grid-cols-2">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-gray-700">
                    npm run package:skills -- {selectedSkill.id}
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-gray-700">
                    npm run check:skills
                  </div>
                </div>
              </section>
            </main>
          ) : (
            <main className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-400">
              请选择一个 skill。
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
