"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Diff,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  FolderTree,
  History,
  Loader2,
  MoreVertical,
  PackageCheck,
  Pencil,
  RotateCcw,
  Rocket,
  Search,
  Trash2,
  TriangleAlert,
  UploadCloud,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import type { SkillHealthStatus, SkillsDashboardData } from '@/lib/quant/skills-dashboard';

type SkillsPayload = SkillsDashboardData;
type ToastState = { type: 'success' | 'error'; message: string } | null;
type SourceFile = SkillsPayload['skills'][number]['source']['files'][number];
type SourceDirectory = SkillsPayload['skills'][number]['source']['directories'][number];
type SourceKind = SourceFile['kind'];
type SourceTreeNode = {
  type: 'directory' | 'file';
  name: string;
  path: string;
  kind: SourceKind;
  file?: SourceFile;
  folder?: SourceDirectory;
  children: SourceTreeNode[];
};
type SourceTreeActionMenu =
  | { type: 'directory'; node: SourceTreeNode; x: number; y: number }
  | { type: 'file'; file: SourceFile; x: number; y: number };
type SourceTreeActionMenuRequest =
  | { type: 'directory'; node: SourceTreeNode }
  | { type: 'file'; file: SourceFile };
type SourceState = {
  skillId: string;
  filePath: string;
  content: string;
  relativePath: string;
  size: number;
  updatedAt: string | null;
  editable: boolean;
  skillMd?: string;
};
type SkillDiffFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  previousSize: number | null;
  currentSize: number | null;
  previousUpdatedAt: string | null;
  currentUpdatedAt: string | null;
  addedLines: number;
  removedLines: number;
  preview: string[];
};
type SkillDiffData = {
  skillId: string;
  baseVersion: string | null;
  basePackagePath: string | null;
  changed: boolean;
  files: SkillDiffFile[];
  totals: {
    added: number;
    modified: number;
    deleted: number;
    addedLines: number;
    removedLines: number;
  };
};

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

const fileKindLabels: Record<SourceFile['kind'], string> = {
  instruction: '说明',
  reference: '引用',
  script: '脚本',
  asset: '资源',
  agent: '元数据',
  other: '其他',
};

function fileKindClass(kind: SourceFile['kind']) {
  switch (kind) {
    case 'instruction':
      return 'border-red-100 bg-red-50 text-red-700';
    case 'reference':
      return 'border-blue-100 bg-blue-50 text-blue-700';
    case 'script':
      return 'border-emerald-100 bg-emerald-50 text-emerald-700';
    case 'asset':
      return 'border-amber-100 bg-amber-50 text-amber-700';
    case 'agent':
      return 'border-violet-100 bg-violet-50 text-violet-700';
    default:
      return 'border-gray-200 bg-gray-50 text-gray-600';
  }
}

function directoryKind(relativePath: string): SourceKind {
  if (relativePath === 'references' || relativePath.startsWith('references/')) return 'reference';
  if (relativePath === 'scripts' || relativePath.startsWith('scripts/')) return 'script';
  if (relativePath === 'assets' || relativePath.startsWith('assets/')) return 'asset';
  if (relativePath === 'agents' || relativePath.startsWith('agents/')) return 'agent';
  return 'other';
}

function parentDirectoryPaths(relativePath: string): string[] {
  const parts = relativePath.split('/').filter(Boolean);
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join('/'));
  }
  return parents;
}

function directParentPath(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function lastPathPart(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? relativePath;
}

function descendantFileCount(node: SourceTreeNode): number {
  if (node.type === 'file') return 1;
  return node.children.reduce((total, child) => total + descendantFileCount(child), 0);
}

function buildSourceTree(files: SourceFile[], directories: SourceDirectory[]): SourceTreeNode[] {
  const root: SourceTreeNode = {
    type: 'directory',
    name: '',
    path: '',
    kind: 'other',
    children: [],
  };
  const nodes = new Map<string, SourceTreeNode>([['', root]]);

  function ensureDirectory(relativePath: string, folder?: SourceDirectory) {
    if (!relativePath) return root;
    const existing = nodes.get(relativePath);
    if (existing) {
      if (folder) {
        existing.folder = folder;
        existing.kind = folder.kind;
      }
      return existing;
    }

    const parentPath = directParentPath(relativePath);
    const parent = ensureDirectory(parentPath);
    const node: SourceTreeNode = {
      type: 'directory',
      name: lastPathPart(relativePath),
      path: relativePath,
      kind: folder?.kind ?? directoryKind(relativePath),
      folder,
      children: [],
    };
    parent.children.push(node);
    nodes.set(relativePath, node);
    return node;
  }

  directories.forEach((folder) => ensureDirectory(folder.path, folder));

  files.forEach((file) => {
    const parents = parentDirectoryPaths(file.path);
    const parent = ensureDirectory(parents[parents.length - 1] ?? '');
    parent.children.push({
      type: 'file',
      name: lastPathPart(file.path),
      path: file.path,
      kind: file.kind,
      file,
      children: [],
    });
  });

  function sortChildren(node: SourceTreeNode) {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
  }
  sortChildren(root);

  return root.children;
}

function filterSourceTree(nodes: SourceTreeNode[], keyword: string): SourceTreeNode[] {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return nodes;

  return nodes.flatMap((node) => {
    const childMatches = filterSourceTree(node.children, normalized);
    const selfMatches = [
      node.name,
      node.path,
      fileKindLabels[node.kind],
      node.file?.editable ? '可编辑' : '',
    ]
      .join(' ')
      .toLowerCase()
      .includes(normalized);
    if (!selfMatches && childMatches.length === 0) return [];
    return [{
      ...node,
      children: childMatches,
    }];
  });
}

function VersionManagerDialog({
  open,
  selectedSkill,
  sourceDirty,
  releaseVersion,
  releaseSummary,
  releaseChanges,
  uploadFile,
  diffData,
  isPublishing,
  isUploading,
  isLoadingDiff,
  rollingBackVersion,
  isDraggingUpload,
  onClose,
  onVersionChange,
  onSummaryChange,
  onChangesChange,
  onLoadDiff,
  onPublish,
  onRollback,
  onUpload,
  onPackageDrop,
  onPackageDragOver,
  onPackageDragLeave,
  onPackageSelect,
}: {
  open: boolean;
  selectedSkill: SkillsPayload['skills'][number] | null;
  sourceDirty: boolean;
  releaseVersion: string;
  releaseSummary: string;
  releaseChanges: string;
  uploadFile: File | null;
  diffData: SkillDiffData | null;
  isPublishing: boolean;
  isUploading: boolean;
  isLoadingDiff: boolean;
  rollingBackVersion: string | null;
  isDraggingUpload: boolean;
  onClose: () => void;
  onVersionChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onChangesChange: (value: string) => void;
  onLoadDiff: () => void;
  onPublish: () => void;
  onRollback: (version: string) => void;
  onUpload: () => void;
  onPackageDrop: (event: React.DragEvent<HTMLLabelElement>) => void;
  onPackageDragOver: (event: React.DragEvent<HTMLLabelElement>) => void;
  onPackageDragLeave: () => void;
  onPackageSelect: (file: File | null) => void;
}) {
  if (!open || !selectedSkill) return null;

  return (
    <div className="fixed inset-0 z-50 max-w-full overflow-x-hidden bg-black/20 p-3 backdrop-blur-sm sm:p-4">
      <div className="mx-auto flex h-full max-h-[calc(100vh-32px)] max-w-7xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b px-4 py-4 sm:gap-4 sm:px-6 sm:py-5">
          <div className="flex items-center gap-4">
            <div className="hidden h-14 w-14 items-center justify-center rounded-full bg-violet-50 text-violet-600 sm:flex">
              <History className="h-7 w-7" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold tracking-normal text-gray-950 sm:text-2xl">版本管理</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                QuantPilot Skills 管理 · Skill: {selectedSkill.id}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-gray-950"
            aria-label="关闭版本管理"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="min-w-0 px-4 py-4 sm:px-6 sm:py-5">
            <div className="max-w-full overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="bg-muted/40 text-xs font-semibold text-gray-500">
                  <tr>
                    <th className="w-[150px] px-4 py-3">版本号</th>
                    <th className="px-4 py-3">变更说明</th>
                    <th className="px-4 py-3">更新人</th>
                    <th className="px-4 py-3">更新时间</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedSkill.changelog.releases.length > 0 ? (
                    selectedSkill.changelog.releases.map((release) => {
                      const current = release.version === selectedSkill.version;
                      return (
                        <tr key={`${release.version}-${release.date}`} className="border-t">
                          <td className="px-4 py-4 font-semibold text-gray-950">
                            <div className="flex flex-wrap items-center gap-2">
                              v{release.version}
                              {current && (
                                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                  当前版本
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4 text-gray-700">
                            <div className="max-w-xl">
                              <div>{release.summary || '-'}</div>
                              {release.changes.length > 0 && (
                                <div className="mt-1 truncate text-xs text-muted-foreground">
                                  {release.changes.join('；')}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4 text-muted-foreground">QuantPilot</td>
                          <td className="px-4 py-4 text-muted-foreground">{release.date}</td>
                          <td className="px-4 py-4">
                            <div className="flex justify-end gap-2 whitespace-nowrap">
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                onClick={() => onRollback(release.version)}
                                disabled={current || !release.snapshot?.exists || rollingBackVersion === release.version}
                              >
                                {rollingBackVersion === release.version ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-4 w-4" />
                                )}
                                回滚
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                asChild={current && selectedSkill.package.exists}
                                disabled={!current || !selectedSkill.package.exists}
                              >
                                {current && selectedSkill.package.exists ? (
                                  <a href={`/api/skills/${selectedSkill.id}/package`} download>
                                    <Download className="h-4 w-4" />
                                    下载
                                  </a>
                                ) : (
                                  <>
                                    <Download className="h-4 w-4" />
                                    下载
                                  </>
                                )}
                              </Button>
                              <Button type="button" size="sm" disabled>
                                <CheckCircle2 className="h-4 w-4" />
                                应用
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                        当前 skill 暂无版本记录。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-5">
              <Card className="min-w-0 p-5">
                <div className="mb-4 flex items-center gap-2">
                  <Rocket className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <h3 className="text-base font-semibold">发布新版本</h3>
                    <p className="text-xs text-muted-foreground">更新 registry、changelog、lock 和压缩包。</p>
                  </div>
                </div>
                <div className="grid gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="release-version-dialog">版本号</Label>
                    <Input
                      id="release-version-dialog"
                      value={releaseVersion}
                      onChange={(event) => onVersionChange(event.target.value)}
                      placeholder="例如 0.3.3"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="release-summary-dialog">发布摘要</Label>
                    <Input
                      id="release-summary-dialog"
                      value={releaseSummary}
                      onChange={(event) => onSummaryChange(event.target.value)}
                      placeholder="简短说明这次版本解决的问题"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="release-changes-dialog">变更点</Label>
                    <Textarea
                      id="release-changes-dialog"
                      value={releaseChanges}
                      onChange={(event) => onChangesChange(event.target.value)}
                      className="min-h-[110px]"
                      placeholder={'每行一条，例如：\n增强持仓截图字段提取契约\n补充数据质量校验规则'}
                    />
                  </div>
                </div>
                <div className="mt-4 rounded-md border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
                  发版前先加载变更对比，确认本地源码目录相对上一版包的改动后再发布。
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={onLoadDiff}
                  disabled={isLoadingDiff || sourceDirty}
                >
                  {isLoadingDiff ? <Loader2 className="h-4 w-4 animate-spin" /> : <Diff className="h-4 w-4" />}
                  生成发布前 Diff
                </Button>
                <Button
                  type="button"
                  className="mt-4 w-full"
                  onClick={onPublish}
                  disabled={isPublishing || sourceDirty || isLoadingDiff || !diffData}
                >
                  {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
                  确认 Diff 后发布
                </Button>
                {sourceDirty && <p className="mt-2 text-xs text-amber-600">先保存源码，再发布版本。</p>}
                {!sourceDirty && !diffData && <p className="mt-2 text-xs text-muted-foreground">发布前需要先生成 Diff。</p>}
              </Card>

              <Card className="min-w-0 p-5">
                <div className="mb-4 flex items-center gap-2">
                  <Diff className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <h3 className="text-base font-semibold">发布前变更对比</h3>
                    <p className="text-xs text-muted-foreground">
                      对比当前源码和 {diffData?.baseVersion ? `v${diffData.baseVersion}` : '上一版包'}。
                    </p>
                  </div>
                </div>
                {diffData ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="rounded-md border bg-emerald-50 p-2 text-emerald-700">
                        新增 {diffData.totals.added}
                      </div>
                      <div className="rounded-md border bg-blue-50 p-2 text-blue-700">
                        修改 {diffData.totals.modified}
                      </div>
                      <div className="rounded-md border bg-red-50 p-2 text-red-700">
                        删除 {diffData.totals.deleted}
                      </div>
                    </div>
                    <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                      {diffData.files.length > 0 ? diffData.files.map((file) => (
                        <div key={`${file.status}-${file.path}`} className="rounded-md border bg-white p-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className={`rounded-full px-2 py-0.5 font-semibold ${
                              file.status === 'added'
                                ? 'bg-emerald-50 text-emerald-700'
                                : file.status === 'deleted'
                                  ? 'bg-red-50 text-red-700'
                                  : 'bg-blue-50 text-blue-700'
                            }`}>
                              {file.status === 'added' ? '新增' : file.status === 'deleted' ? '删除' : '修改'}
                            </span>
                            <span className="min-w-0 break-all font-mono text-gray-950">{file.path}</span>
                          </div>
                          <div className="mt-2 text-xs text-muted-foreground">
                            +{file.addedLines} / -{file.removedLines} · {formatBytes(file.currentSize ?? file.previousSize ?? 0)}
                          </div>
                          <pre className="mt-2 max-h-28 overflow-auto rounded bg-gray-950 p-2 text-[11px] leading-4 text-gray-100">
                            {file.preview.join('\n')}
                          </pre>
                        </div>
                      )) : (
                        <div className="rounded-md border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-700">
                          当前源码与上一版包一致，没有待发布变更。
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    点击左侧“生成发布前 Diff”后展示所有待发布改动。
                  </div>
                )}
              </Card>
            </div>

            <div className="mt-5">
              <Card className="min-w-0 p-5">
                <div className="mb-4 flex items-center gap-2">
                  <UploadCloud className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <h3 className="text-base font-semibold">上传新包</h3>
                    <p className="text-xs text-muted-foreground">支持 zip、tgz、tar.gz；包内需包含 SKILL.md。</p>
                  </div>
                </div>
                <label
                  htmlFor="skill-upload-dialog"
                  onDragOver={onPackageDragOver}
                  onDragLeave={onPackageDragLeave}
                  onDrop={onPackageDrop}
                  className={`flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-8 text-center text-sm transition-colors ${
                    isDraggingUpload
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  <UploadCloud className="mb-2 h-5 w-5" />
                  {uploadFile ? uploadFile.name : '拖拽或点击选择 skill 压缩包'}
                  <input
                    id="skill-upload-dialog"
                    type="file"
                    accept=".zip,.tgz,.tar.gz,application/gzip,application/zip"
                    className="sr-only"
                    onChange={(event) => onPackageSelect(event.target.files?.[0] ?? null)}
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4 w-full"
                  onClick={onUpload}
                  disabled={isUploading || !uploadFile || !releaseVersion || !releaseSummary || !releaseChanges}
                >
                  {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                  上传并发布为当前版本
                </Button>
              </Card>
            </div>

          </div>
        </div>

        <div className="border-t bg-muted/40 p-4">
          <Button type="button" variant="secondary" className="w-full" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}

function SourceTree({
  nodes,
  selectedFilePath,
  expandedPaths,
  deletingFolderPath,
  deletingFilePath,
  creatingFolderBasePath,
  openMenuPath,
  onToggleDirectory,
  onSelectFile,
  onOpenActionMenu,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onDeleteFolder,
}: {
  nodes: SourceTreeNode[];
  selectedFilePath: string;
  expandedPaths: Set<string>;
  deletingFolderPath: string | null;
  deletingFilePath: string | null;
  creatingFolderBasePath: string | null;
  openMenuPath: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (file: SourceFile) => void;
  onOpenActionMenu: (event: React.SyntheticEvent<HTMLButtonElement>, menu: SourceTreeActionMenuRequest) => void;
  onCreateFile: (basePath?: string) => void;
  onCreateFolder: (basePath?: string) => void;
  onDeleteFile: (file: SourceFile) => void;
  onDeleteFolder: (folder: SourceDirectory) => void;
}) {
  if (nodes.length === 0) {
    return <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的文件</div>;
  }

  function renderNode(node: SourceTreeNode, depth: number): React.ReactNode {
    if (node.type === 'directory') {
      const expanded = expandedPaths.has(node.path);
      const fileCount = node.folder?.fileCount ?? descendantFileCount(node);
      return (
        <div key={node.path}>
          <div
            className="group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-background"
            style={{ paddingLeft: `${8 + depth * 16}px` }}
          >
            <button
              type="button"
              onClick={() => onToggleDirectory(node.path)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              aria-label={expanded ? `收起 ${node.path}` : `展开 ${node.path}`}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {expanded ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-amber-600" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-amber-600" />
            )}
            <button
              type="button"
              onClick={() => onToggleDirectory(node.path)}
              className="min-w-0 flex-1 truncate text-left font-mono text-xs text-gray-950"
              title={node.path}
            >
              {node.name}
            </button>
            <span className={`hidden shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] sm:inline-flex ${fileKindClass(node.kind)}`}>
              {fileKindLabels[node.kind]}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{fileCount}</span>
            <button
              type="button"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-gray-950 sm:h-6 sm:w-6 ${
                openMenuPath === node.path ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
              }`}
              title={`${node.path} 操作`}
              onClick={(event) => onOpenActionMenu(event, { type: 'directory', node })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  onOpenActionMenu(event, { type: 'directory', node });
                }
              }}
            >
              {deletingFolderPath === node.path || creatingFolderBasePath === node.path ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MoreVertical className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          {expanded && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const file = node.file as SourceFile;
    const active = file.path === selectedFilePath;
    return (
      <div
        key={file.path}
        className={`group mb-0.5 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
          active
            ? 'border-primary/25 bg-primary/10'
            : 'border-transparent hover:border-border hover:bg-background'
        } ${!file.editable ? 'cursor-not-allowed opacity-60' : ''}`}
        style={{ paddingLeft: `${29 + depth * 16}px` }}
        title={file.path}
      >
        <button
          type="button"
          onClick={() => onSelectFile(file)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <FileText className="h-4 w-4 shrink-0 text-slate-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-xs text-gray-950">{node.name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>{formatBytes(file.size)}</span>
              <span>•</span>
              <span>{file.updatedAt ? `更新 ${formatTime(file.updatedAt)}` : '更新时间未知'}</span>
            </div>
          </div>
          <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${fileKindClass(file.kind)}`}>
            {fileKindLabels[file.kind]}
          </span>
        </button>
        <button
          type="button"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-gray-950 sm:h-6 sm:w-6 ${
            openMenuPath === file.path ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
          }`}
          title={`${file.path} 操作`}
          onClick={(event) => onOpenActionMenu(event, { type: 'file', file })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              onOpenActionMenu(event, { type: 'file', file });
            }
          }}
        >
          {deletingFilePath === file.path ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MoreVertical className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    );
  }

  return <div className="space-y-0.5">{nodes.map((node) => renderNode(node, 0))}</div>;
}

function SourceTreeActionMenuOverlay({
  menu,
  deletingFolderPath,
  deletingFilePath,
  onClose,
  onSelectFile,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onDeleteFolder,
}: {
  menu: SourceTreeActionMenu | null;
  deletingFolderPath: string | null;
  deletingFilePath: string | null;
  onClose: () => void;
  onSelectFile: (file: SourceFile) => void;
  onCreateFile: (basePath?: string) => void;
  onCreateFolder: (basePath?: string) => void;
  onDeleteFile: (file: SourceFile) => void;
  onDeleteFolder: (folder: SourceDirectory) => void;
}) {
  if (!menu) return null;

  const isDirectory = menu.type === 'directory';
  const file = menu.type === 'file' ? menu.file : null;
  const folder = menu.type === 'directory' ? menu.node.folder : null;
  const pathValue = isDirectory ? menu.node.path : file?.path ?? '';
  const width = isDirectory ? 144 : 128;
  const left = Math.min(Math.max(12, menu.x - width + 24), Math.max(12, window.innerWidth - width - 12));
  const maxMenuHeight = isDirectory ? 132 : file?.path === 'SKILL.md' ? 92 : 132;
  const top = Math.min(menu.y + 8, Math.max(12, window.innerHeight - maxMenuHeight - 12));

  function actionButtonClass(tone: 'default' | 'danger' = 'default') {
    return `flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
      tone === 'danger'
        ? 'text-red-600 hover:bg-red-50'
        : 'text-gray-700 hover:bg-gray-100'
    }`;
  }

  function run(action: () => void) {
    onClose();
    action();
  }

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 cursor-default bg-transparent"
        aria-label="关闭文件树菜单"
        onClick={onClose}
      />
      <div
        data-testid="source-tree-action-menu"
        className="fixed z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        style={{ left, top, width }}
      >
        {isDirectory ? (
          <>
            <button
              type="button"
              className={actionButtonClass()}
              onClick={() => run(() => onCreateFile(pathValue))}
            >
              <FilePlus2 className="h-4 w-4 text-emerald-600" />
              创建文件
            </button>
            <button
              type="button"
              className={actionButtonClass()}
              onClick={() => run(() => onCreateFolder(pathValue))}
            >
              <FolderPlus className="h-4 w-4 text-blue-600" />
              创建目录
            </button>
            {folder && (
              <button
                type="button"
                className={actionButtonClass('danger')}
                onClick={() => run(() => onDeleteFolder(folder))}
                disabled={deletingFolderPath === pathValue}
              >
                <Trash2 className="h-4 w-4" />
                删除目录
              </button>
            )}
          </>
        ) : file ? (
          <>
            <button
              type="button"
              className={actionButtonClass()}
              onClick={() => run(() => onCreateFile(directParentPath(file.path) || undefined))}
            >
              <FilePlus2 className="h-4 w-4 text-emerald-600" />
              创建
            </button>
            <button
              type="button"
              className={actionButtonClass()}
              onClick={() => run(() => onSelectFile(file))}
            >
              <Pencil className="h-4 w-4 text-blue-600" />
              修改
            </button>
            {file.path !== 'SKILL.md' && (
              <button
                type="button"
                className={actionButtonClass('danger')}
                onClick={() => run(() => onDeleteFile(file))}
                disabled={deletingFilePath === file.path}
              >
                {deletingFilePath === file.path ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                删除
              </button>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}

export default function SkillsManagementClient({ initialData }: { initialData: SkillsPayload }) {
  const [payload, setPayload] = useState<SkillsPayload>(initialData);
  const [selectedId, setSelectedId] = useState<string | null>(initialData.skills[0]?.id ?? null);
  const [isSkillSelectorOpen, setIsSkillSelectorOpen] = useState(false);
  const [isVersionManagerOpen, setIsVersionManagerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | SkillHealthStatus>('all');
  const [source, setSource] = useState<SourceState | null>(null);
  const [sourceDraft, setSourceDraft] = useState('');
  const [selectedFilePath, setSelectedFilePath] = useState('SKILL.md');
  const [sourceFileQuery, setSourceFileQuery] = useState('');
  const [expandedSourcePaths, setExpandedSourcePaths] = useState<Set<string>>(new Set());
  const [sourceActionMenu, setSourceActionMenu] = useState<SourceTreeActionMenu | null>(null);
  const [isLoadingSource, setIsLoadingSource] = useState(false);
  const [isSavingSource, setIsSavingSource] = useState(false);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const [creatingFolderBasePath, setCreatingFolderBasePath] = useState<string | null>(null);
  const [deletingFolderPath, setDeletingFolderPath] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffData, setDiffData] = useState<SkillDiffData | null>(null);
  const [rollingBackVersion, setRollingBackVersion] = useState<string | null>(null);
  const [releaseVersion, setReleaseVersion] = useState('');
  const [releaseSummary, setReleaseSummary] = useState('');
  const [releaseChanges, setReleaseChanges] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isDraggingUpload, setIsDraggingUpload] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const activeSourceRequest = useRef(0);

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

  const sourceDirty = Boolean(source && source.skillId === selectedSkill?.id && sourceDraft !== source.content);
  const sourceTree = useMemo(() => {
    if (!selectedSkill) return [];
    return buildSourceTree(selectedSkill.source.files, selectedSkill.source.directories);
  }, [selectedSkill]);
  const visibleSourceTree = useMemo(
    () => filterSourceTree(sourceTree, sourceFileQuery),
    [sourceTree, sourceFileQuery]
  );

  function showToast(nextToast: ToastState) {
    setToast(nextToast);
    if (nextToast) {
      window.setTimeout(() => setToast(null), 3200);
    }
  }

  async function postJson<T>(body: Record<string, unknown>): Promise<T> {
    const response = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || 'skills 操作失败');
    }
    return payload.data as T;
  }

  async function refreshDashboard() {
    const response = await fetch('/api/skills', { cache: 'no-store' });
    const nextPayload = await response.json().catch(() => ({}));
    if (!response.ok || !nextPayload.success) {
      throw new Error(nextPayload.error || '刷新 skills 状态失败');
    }
    setPayload(nextPayload.data as SkillsPayload);
    return nextPayload.data as SkillsPayload;
  }

  async function loadSource(skillId: string, filePath = selectedFilePath || 'SKILL.md') {
    const requestId = activeSourceRequest.current + 1;
    activeSourceRequest.current = requestId;
    setIsLoadingSource(true);
    try {
      const nextSource = await postJson<SourceState>({ action: 'read-file', skillId, filePath });
      if (activeSourceRequest.current !== requestId) return;
      setSource(nextSource);
      setSourceDraft(nextSource.content);
      setSelectedFilePath(nextSource.filePath);
    } catch (error) {
      if (activeSourceRequest.current !== requestId) return;
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeSourceRequest.current === requestId) {
        setIsLoadingSource(false);
      }
    }
  }

  function selectSourceFile(file: SourceFile) {
    if (!selectedSkill) return;
    if (!file.editable) {
      showToast({ type: 'error', message: '该文件不是可在线编辑的文本文件，可以通过上传压缩包更新。' });
      return;
    }
    if (sourceDirty && !window.confirm('当前文件有未保存修改，确定切换文件吗？')) {
      return;
    }
    setSelectedFilePath(file.path);
    void loadSource(selectedSkill.id, file.path);
  }

  function selectSkill(skillId: string) {
    if (sourceDirty && !window.confirm('当前文件有未保存修改，确定切换 skill 吗？')) {
      return;
    }
    setSelectedId(skillId);
    setIsSkillSelectorOpen(false);
    setSourceActionMenu(null);
  }

  function toggleSourceDirectory(folderPath: string) {
    setExpandedSourcePaths((previous) => {
      const next = new Set(previous);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }

  function openSourceActionMenu(
    event: React.SyntheticEvent<HTMLButtonElement>,
    menu: SourceTreeActionMenuRequest
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setSourceActionMenu({
      ...menu,
      x: rect.right,
      y: rect.bottom,
    } as SourceTreeActionMenu);
  }

  async function saveSource() {
    if (!selectedSkill || !source) return;
    setIsSavingSource(true);
    try {
      const nextSource = await postJson<SourceState>({
        action: 'save-file',
        skillId: selectedSkill.id,
        filePath: source.filePath,
        content: sourceDraft,
      });
      setSource(nextSource);
      setSourceDraft(nextSource.content);
      setDiffData(null);
      await refreshDashboard();
      showToast({ type: 'success', message: '文件已保存，发布版本前请确认变更说明并重新打包。' });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsSavingSource(false);
    }
  }

  async function createSourceFile(basePath?: string) {
    if (!selectedSkill) return;
    if (sourceDirty && !window.confirm('当前文件有未保存修改，确定先创建新文件吗？')) {
      return;
    }
    const defaultPath = basePath ? `${basePath}/new_file.md` : 'references/provider_notes.md';
    const filePath = window.prompt('输入新文件路径，例如 references/provider_notes.md 或 scripts/new_metric.py', defaultPath)?.trim();
    if (!filePath) return;
    setCreatingFolderBasePath(basePath ?? '__root__');
    try {
      const nextSource = await postJson<SourceState>({
        action: 'save-file',
        skillId: selectedSkill.id,
        filePath,
        content: filePath.endsWith('.py')
          ? '#!/usr/bin/env python3\n'
          : filePath.endsWith('.json')
            ? '{}\n'
            : '',
      });
      setSource(nextSource);
      setSourceDraft(nextSource.content);
      setSelectedFilePath(nextSource.filePath);
      setDiffData(null);
      await refreshDashboard();
      if (basePath) {
        setExpandedSourcePaths((previous) => new Set([...previous, basePath]));
      }
      showToast({ type: 'success', message: '文件已创建，发布版本前请补充变更说明。' });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setCreatingFolderBasePath(null);
    }
  }

  async function createSourceFolder(basePath?: string) {
    if (!selectedSkill) return;
    const defaultPath = basePath ? `${basePath}/new-folder` : 'references';
    const folderPath = window.prompt('输入新文件夹路径，例如 references、scripts/helpers 或 assets/icons', defaultPath)?.trim();
    if (!folderPath) return;
    setCreatingFolderBasePath(basePath ?? '__root__');
    try {
      const nextPayload = await postJson<SkillsPayload>({
        action: 'create-folder',
        skillId: selectedSkill.id,
        folderPath,
      });
      setPayload(nextPayload);
      setDiffData(null);
      setExpandedSourcePaths((previous) => new Set([...previous, folderPath, ...(basePath ? [basePath] : [])]));
      showToast({ type: 'success', message: '文件夹已创建，可继续创建文件或上传完整压缩包发布新版本。' });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setCreatingFolderBasePath(null);
    }
  }

  async function deleteSourceFile(file?: SourceFile) {
    if (!selectedSkill) return;
    const targetFile = file ?? selectedSkill.source.files.find((item) => item.path === source?.filePath);
    if (!targetFile || targetFile.path === 'SKILL.md') return;
    if (!window.confirm(`确定删除 ${targetFile.path} 吗？删除后需要发布新版本才会同步到包。`)) {
      return;
    }
    setDeletingFilePath(targetFile.path);
    try {
      const nextPayload = await postJson<SkillsPayload>({
        action: 'delete-file',
        skillId: selectedSkill.id,
        filePath: targetFile.path,
      });
      setPayload(nextPayload);
      setDiffData(null);
      if (selectedFilePath === targetFile.path) {
        setSelectedFilePath('SKILL.md');
        setSource(null);
        setSourceDraft('');
        await loadSource(selectedSkill.id, 'SKILL.md');
      }
      showToast({ type: 'success', message: '文件已删除，发布版本前请确认变更说明。' });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeletingFilePath(null);
    }
  }

  async function deleteSourceFolder(folder: SourceDirectory) {
    if (!selectedSkill) return;
    if (!window.confirm(`确定删除文件夹 ${folder.path} 及其中所有文件吗？删除后需要发布新版本才会同步到包。`)) {
      return;
    }
    setDeletingFolderPath(folder.path);
    try {
      const nextPayload = await postJson<SkillsPayload>({
        action: 'delete-folder',
        skillId: selectedSkill.id,
        folderPath: folder.path,
      });
      setPayload(nextPayload);
      setDiffData(null);
      if (selectedFilePath === folder.path || selectedFilePath.startsWith(`${folder.path}/`)) {
        setSelectedFilePath('SKILL.md');
        setSource(null);
        setSourceDraft('');
        await loadSource(selectedSkill.id, 'SKILL.md');
      }
      showToast({ type: 'success', message: '文件夹已删除，发布版本前请确认变更说明。' });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeletingFolderPath(null);
    }
  }

  async function publishVersion() {
    if (!selectedSkill) return;
    if (!diffData) {
      showToast({ type: 'error', message: '请先生成发布前 Diff，再确认发版。' });
      return;
    }
    const shouldPublish = window.confirm(
      `确认发布 ${selectedSkill.id} v${releaseVersion}？\n\n` +
      `本次变更：新增 ${diffData.totals.added}，修改 ${diffData.totals.modified}，删除 ${diffData.totals.deleted}。`
    );
    if (!shouldPublish) return;
    setIsPublishing(true);
    try {
      const nextPayload = await postJson<SkillsPayload>({
        action: 'publish-version',
        skillId: selectedSkill.id,
        version: releaseVersion,
        summary: releaseSummary,
        changes: releaseChanges,
        status: selectedSkill.status,
      });
      setPayload(nextPayload);
      setReleaseSummary('');
      setReleaseChanges('');
      setDiffData(null);
      setReleaseVersion(nextPayload.skills.find((skill) => skill.id === selectedSkill.id)?.version ?? releaseVersion);
      showToast({ type: 'success', message: '版本已发布，并已重新打包 skill。' });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsPublishing(false);
    }
  }

  async function loadVersionDiff() {
    if (!selectedSkill) return;
    if (sourceDirty) {
      showToast({ type: 'error', message: '请先保存当前文件，再生成发布前 Diff。' });
      return;
    }
    setIsLoadingDiff(true);
    try {
      const nextDiff = await postJson<SkillDiffData>({
        action: 'diff-version',
        skillId: selectedSkill.id,
      });
      setDiffData(nextDiff);
      showToast({
        type: 'success',
        message: nextDiff.changed ? '发布前 Diff 已生成，请确认后发版。' : '当前源码与上一版一致。',
      });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsLoadingDiff(false);
    }
  }

  async function rollbackVersion(version: string) {
    if (!selectedSkill) return;
    const shouldRollback = window.confirm(
      `确认将 ${selectedSkill.id} 回退到 v${version}？\n\n当前源码目录会被该版本快照覆盖。`
    );
    if (!shouldRollback) return;
    setRollingBackVersion(version);
    try {
      const nextPayload = await postJson<SkillsPayload>({
        action: 'rollback-version',
        skillId: selectedSkill.id,
        version,
      });
      setPayload(nextPayload);
      setDiffData(null);
      setReleaseSummary('');
      setReleaseChanges('');
      setReleaseVersion(version);
      await loadSource(selectedSkill.id, 'SKILL.md');
      showToast({ type: 'success', message: `已回退到 v${version}，并重新打包。` });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRollingBackVersion(null);
    }
  }

  function setSelectedUpload(file: File | null) {
    if (!file) return;
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith('.zip') && !fileName.endsWith('.tgz') && !fileName.endsWith('.tar.gz')) {
      showToast({ type: 'error', message: '仅支持 .zip、.tgz 或 .tar.gz。' });
      return;
    }
    setUploadFile(file);
  }

  function handlePackageDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingUpload(false);
    setSelectedUpload(event.dataTransfer.files?.[0] ?? null);
  }

  async function uploadPackage() {
    if (!selectedSkill || !uploadFile) return;
    setIsUploading(true);
    try {
      const form = new FormData();
      form.set('action', 'upload-package');
      form.set('skillId', selectedSkill.id);
      form.set('version', releaseVersion);
      form.set('summary', releaseSummary);
      form.set('changes', releaseChanges);
      form.set('status', selectedSkill.status);
      form.set('file', uploadFile);
      const response = await fetch('/api/skills', { method: 'POST', body: form });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        throw new Error(result.error || '上传失败');
      }
      setPayload(result.data as SkillsPayload);
      setUploadFile(null);
      setDiffData(null);
      setSelectedFilePath('SKILL.md');
      await loadSource(selectedSkill.id, 'SKILL.md');
      showToast({ type: 'success', message: '上传包已作为新版本发布，并已重新打包。' });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsUploading(false);
    }
  }

  function handlePackageDragOver(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingUpload(true);
  }

  useEffect(() => {
    if (!selectedSkill && filteredSkills[0]) {
      setSelectedId(filteredSkills[0].id);
    }
  }, [filteredSkills, selectedSkill]);

  useEffect(() => {
    setSourceActionMenu(null);
    if (!selectedSkill) return;
    activeSourceRequest.current += 1;
    setSource(null);
    setSourceDraft('');
    setSelectedFilePath('SKILL.md');
    setSourceFileQuery('');
    setExpandedSourcePaths(new Set(selectedSkill.source.directories.map((folder) => folder.path)));
    setIsLoadingSource(false);
    setReleaseVersion(selectedSkill.version);
    setReleaseSummary('');
    setReleaseChanges('');
      setUploadFile(null);
      setDiffData(null);
      setIsDraggingUpload(false);
      void loadSource(selectedSkill.id, 'SKILL.md');
  }, [selectedSkill?.id]);

  useEffect(() => {
    if (!sourceActionMenu) return;
    let canCloseFromScroll = false;
    const timer = window.setTimeout(() => {
      canCloseFromScroll = true;
    }, 250);
    function closeOnScroll() {
      if (!canCloseFromScroll) return;
      setSourceActionMenu(null);
    }
    function closeNow() {
      setSourceActionMenu(null);
    }
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeNow);
    window.addEventListener('keydown', closeNow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeNow);
      window.removeEventListener('keydown', closeNow);
    };
  }, [sourceActionMenu]);

  useEffect(() => {
    if (isSkillSelectorOpen || isVersionManagerOpen) {
      setSourceActionMenu(null);
    }
  }, [isSkillSelectorOpen, isVersionManagerOpen]);

  useEffect(() => {
    if (!selectedSkill) return;
    setExpandedSourcePaths((previous) => {
      const next = new Set(previous);
      selectedSkill.source.directories.forEach((folder) => {
        if (sourceFileQuery.trim() || selectedFilePath.startsWith(`${folder.path}/`)) {
          next.add(folder.path);
        }
      });
      return next;
    });
  }, [selectedSkill, selectedFilePath, sourceFileQuery]);

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

        <Sheet open={isSkillSelectorOpen} onOpenChange={setIsSkillSelectorOpen}>
          <SheetContent side="left" className="flex w-[440px] max-w-[92vw] flex-col p-0 sm:max-w-[520px]">
            <SheetHeader className="border-b px-5 py-4">
              <SheetTitle>选择 Skill</SheetTitle>
              <SheetDescription>搜索并切换到需要维护的能力包。</SheetDescription>
            </SheetHeader>
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
            <div className="flex-1 overflow-y-auto p-2">
              {filteredSkills.map((skill) => {
                const active = selectedSkill?.id === skill.id;
                return (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => selectSkill(skill.id)}
                    className={`mb-1 w-full rounded-lg border p-3 text-left transition-colors ${
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
                      <span>{skill.changelog.releaseCount} 个版本</span>
                      <span>•</span>
                      <span>{skill.source.fileCount} 文件</span>
                      <span>•</span>
                      <span>{skill.source.directoryCount} 目录</span>
                    </div>
                  </button>
                );
              })}
              {filteredSkills.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-gray-400">没有匹配的 skill</div>
              )}
            </div>
          </SheetContent>
        </Sheet>

        <div className="space-y-5">
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
                  <div className="flex flex-col gap-3 md:min-w-[220px] md:items-end">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsSkillSelectorOpen(true)}
                      className="w-full"
                    >
                      <Search className="h-4 w-4" />
                      切换 Skill
                    </Button>
                    <Button
                      type="button"
                      onClick={() => setIsVersionManagerOpen(true)}
                      className="w-full"
                    >
                      <History className="h-4 w-4" />
                      版本管理
                    </Button>
                  </div>
                </div>

                {selectedSkill.health.missing.length > 0 && (
                  <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    需要处理：{selectedSkill.health.missing.join('、')}。通常运行 `npm run package:skills -- {selectedSkill.id}` 后再执行 `npm run check:skills`。
                  </div>
                )}
              </section>

              <section>
                <Card className="min-w-0 p-4 sm:p-5">
                  <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                      <Code2 className="h-4 w-4 text-muted-foreground" />
                      <div className="min-w-0">
                        <h2 className="text-base font-semibold">目录级源码编辑</h2>
                        <p className="truncate text-xs text-muted-foreground">
                          {source?.relativePath ?? `${selectedSkill.source.path}/SKILL.md`}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {sourceDirty && <span className="text-xs text-amber-600">有未保存修改</span>}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => loadSource(selectedSkill.id, selectedFilePath)}
                        disabled={isLoadingSource}
                      >
                        {isLoadingSource ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                        重新读取
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={saveSource}
                        disabled={isSavingSource || isLoadingSource || !sourceDirty}
                      >
                        {isSavingSource ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        保存源码
                      </Button>
                    </div>
                  </div>
                  <div className="grid min-w-0 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
                    <div className="min-w-0 rounded-md border bg-muted/20">
                      <div className="flex items-center justify-between border-b px-3 py-2">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          <FolderTree className="h-4 w-4 text-muted-foreground" />
                          文件清单
                        </div>
                        <Badge variant="outline" className="font-normal">
                          {selectedSkill.source.fileCount} 个
                        </Badge>
                      </div>
                      <div className="max-h-[520px] overflow-y-auto p-2">
                        <div className="mb-2 flex gap-2">
                          <div className="relative min-w-0 flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              value={sourceFileQuery}
                              onChange={(event) => setSourceFileQuery(event.target.value)}
                              placeholder="搜索文件..."
                              className="h-9 pl-10 pr-3 text-sm"
                            />
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setExpandedSourcePaths(new Set(selectedSkill.source.directories.map((folder) => folder.path)))}
                            className="h-8 px-2"
                          >
                            展开
                          </Button>
                        </div>
                        <SourceTree
                          nodes={visibleSourceTree}
                          selectedFilePath={selectedFilePath}
                          expandedPaths={expandedSourcePaths}
                          deletingFolderPath={deletingFolderPath}
                          deletingFilePath={deletingFilePath}
                          creatingFolderBasePath={creatingFolderBasePath}
                          openMenuPath={sourceActionMenu?.type === 'directory' ? sourceActionMenu.node.path : sourceActionMenu?.file.path ?? null}
                          onToggleDirectory={toggleSourceDirectory}
                          onSelectFile={selectSourceFile}
                          onOpenActionMenu={openSourceActionMenu}
                          onCreateFile={createSourceFile}
                          onCreateFolder={createSourceFolder}
                          onDeleteFile={deleteSourceFile}
                          onDeleteFolder={deleteSourceFolder}
                        />
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="min-w-0 break-all font-mono">{source?.filePath ?? selectedFilePath}</span>
                        {source ? <span>• {formatBytes(source.size)}</span> : null}
                        {source?.updatedAt ? <span>• 更新 {formatTime(source.updatedAt)}</span> : null}
                      </div>
                      <Textarea
                        value={sourceDraft}
                        onChange={(event) => setSourceDraft(event.target.value)}
                        spellCheck={false}
                        className="min-h-[520px] min-w-0 resize-y overflow-x-auto font-mono text-xs leading-5"
                        placeholder="选择一个可编辑文件..."
                      />
                    </div>
                  </div>
                </Card>

              </section>
            </main>
          ) : (
            <main className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-400">
              请选择一个 skill。
            </main>
          )}
        </div>
      </div>
      <VersionManagerDialog
        open={isVersionManagerOpen}
        selectedSkill={selectedSkill}
        sourceDirty={sourceDirty}
        releaseVersion={releaseVersion}
        releaseSummary={releaseSummary}
        releaseChanges={releaseChanges}
        uploadFile={uploadFile}
        diffData={diffData}
        isPublishing={isPublishing}
        isUploading={isUploading}
        isLoadingDiff={isLoadingDiff}
        rollingBackVersion={rollingBackVersion}
        isDraggingUpload={isDraggingUpload}
        onClose={() => setIsVersionManagerOpen(false)}
        onVersionChange={setReleaseVersion}
        onSummaryChange={setReleaseSummary}
        onChangesChange={setReleaseChanges}
        onLoadDiff={loadVersionDiff}
        onPublish={publishVersion}
        onRollback={rollbackVersion}
        onUpload={uploadPackage}
        onPackageDrop={handlePackageDrop}
        onPackageDragOver={handlePackageDragOver}
        onPackageDragLeave={() => setIsDraggingUpload(false)}
        onPackageSelect={setSelectedUpload}
      />
      <SourceTreeActionMenuOverlay
        menu={sourceActionMenu}
        deletingFolderPath={deletingFolderPath}
        deletingFilePath={deletingFilePath}
        onClose={() => setSourceActionMenu(null)}
        onSelectFile={selectSourceFile}
        onCreateFile={createSourceFile}
        onCreateFolder={createSourceFolder}
        onDeleteFile={deleteSourceFile}
        onDeleteFolder={deleteSourceFolder}
      />
      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 rounded-md border px-4 py-3 text-sm shadow-lg ${
            toast.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
