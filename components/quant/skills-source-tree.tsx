import type { ReactNode, SyntheticEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  Loader2,
  MoreVertical,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCompactDate as formatTime } from '@/components/quant/console-primitives';
import type {
  SkillDiffData,
  SkillsPayload,
  SourceDirectory,
  SourceFile,
  SourceKind,
  SourceState,
} from '@/lib/quant/skills-management-types';

export type { SkillDiffData, SkillsPayload, SourceDirectory, SourceFile, SourceState };
export type SourceTreeNode = {
  type: 'directory' | 'file';
  name: string;
  path: string;
  kind: SourceKind;
  file?: SourceFile;
  folder?: SourceDirectory;
  children: SourceTreeNode[];
};
export type SourceTreeActionMenu =
  | { type: 'directory'; node: SourceTreeNode; x: number; y: number }
  | { type: 'file'; file: SourceFile; x: number; y: number };
export type SourceTreeActionMenuRequest =
  | { type: 'directory'; node: SourceTreeNode }
  | { type: 'file'; file: SourceFile };

export function formatBytes(value: number): string {
  if (!value) return '-';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export const fileKindLabels: Record<SourceFile['kind'], string> = {
  instruction: '说明',
  reference: '引用',
  script: '脚本',
  asset: '资源',
  agent: '元数据',
  other: '其他',
};

export function fileKindClass(kind: SourceFile['kind']) {
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

export function directParentPath(relativePath: string): string {
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

export function buildSourceTree(files: SourceFile[], directories: SourceDirectory[]): SourceTreeNode[] {
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

export function filterSourceTree(nodes: SourceTreeNode[], keyword: string): SourceTreeNode[] {
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

export function SourceTree({
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
  onOpenActionMenu: (event: SyntheticEvent<HTMLButtonElement>, menu: SourceTreeActionMenuRequest) => void;
}) {
  if (nodes.length === 0) {
    return <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的文件</div>;
  }

  function renderNode(node: SourceTreeNode, depth: number): ReactNode {
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

export function SourceTreeActionMenuOverlay({
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
