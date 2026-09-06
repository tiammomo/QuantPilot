'use client';
import { Atom, Bird, Braces, ChevronDown, ChevronRight, Coffee, Database, File, FileCode, FileText, Flame, Folder, FolderOpen, Gem, List, Lock, Palette, Plus, Settings, Ship, Triangle, Type, Workflow } from 'lucide-react';

export type Entry = { path: string; type: 'file'|'dir'; size?: number };

interface TreeViewProps {
  entries: Entry[];
  selectedFile: string;
  expandedFolders: Set<string>;
  folderContents: Map<string, Entry[]>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onLoadFolder: (path: string) => Promise<void>;
  level: number;
  parentPath?: string;
  getFileIcon: (entry: Entry) => React.ReactElement;
}

export function TreeView({ entries, selectedFile, expandedFolders, folderContents, onToggleFolder, onSelectFile, onLoadFolder, level, parentPath = '', getFileIcon }: TreeViewProps) {
  // Ensure entries is an array
  if (!entries || !Array.isArray(entries)) {
    return null;
  }

  // Group entries by directory
  const sortedEntries = [...entries].sort((a, b) => {
    // Directories first
    if (a.type === 'dir' && b.type === 'file') return -1;
    if (a.type === 'file' && b.type === 'dir') return 1;
    // Then alphabetical
    return a.path.localeCompare(b.path);
  });

  return (
    <>
      {sortedEntries.map((entry, index) => {
        // entry.path should already be the full path from API
        const fullPath = entry.path;
        let entryKey =
          fullPath && typeof fullPath === 'string' && fullPath.trim().length > 0
            ? fullPath.trim()
            : (entry as any)?.name && typeof (entry as any).name === 'string' && (entry as any).name.trim().length > 0
            ? `${parentPath || 'root'}::__named_${(entry as any).name.trim()}`
            : '';
        if (!entryKey || entryKey.trim().length === 0) {
          entryKey = `${parentPath || 'root'}::__entry_${level}_${index}_${entry.type}`;
        }
        const isExpanded = expandedFolders.has(fullPath);
        const indent = level * 8;

        return (
          <div key={entryKey}>
            <button
              type="button"
              aria-label={fullPath}
              aria-expanded={entry.type === 'dir' ? isExpanded : undefined}
              className={`group flex w-full text-left items-center h-[22px] px-2 cursor-pointer ${
                selectedFile === fullPath
                  ? 'bg-blue-100 '
                  : 'hover:bg-slate-100 '
              }`}
              style={{ paddingLeft: `${8 + indent}px` }}
              onClick={async () => {
                if (entry.type === 'dir') {
                  // Load folder contents if not already loaded
                  if (!folderContents.has(fullPath)) {
                    await onLoadFolder(fullPath);
                  }
                  onToggleFolder(fullPath);
                } else {
                  onSelectFile(fullPath);
                }
              }}
            >
              {/* Chevron for folders */}
              <span className="w-4 flex items-center justify-center mr-0.5">
                {entry.type === 'dir' && (
                  isExpanded ?
                    <span className="w-2.5 h-2.5 text-slate-600 flex items-center justify-center"><ChevronDown size={10} /></span> :
                    <span className="w-2.5 h-2.5 text-slate-600 flex items-center justify-center"><ChevronRight size={10} /></span>
                )}
              </span>

              {/* Icon */}
              <span className="w-4 h-4 flex items-center justify-center mr-1.5">
                {entry.type === 'dir' ? (
                  isExpanded ?
                    <span className="text-amber-600 w-4 h-4 flex items-center justify-center"><FolderOpen size={16} /></span> :
                    <span className="text-amber-600 w-4 h-4 flex items-center justify-center"><Folder size={16} /></span>
                ) : (
                  getFileIcon(entry)
                )}
              </span>

              {/* File/Folder name */}
              <span className={`text-[13px] leading-[22px] ${
                selectedFile === fullPath ? 'text-blue-700 ' : 'text-slate-700 '
              }`} style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
                {entry.path.split('/').pop() || entry.path}
              </span>
            </button>

            {/* Render children if expanded */}
            {entry.type === 'dir' && isExpanded && folderContents.has(fullPath) && (
              <TreeView
                entries={folderContents.get(fullPath) || []}
                selectedFile={selectedFile}
                expandedFolders={expandedFolders}
                folderContents={folderContents}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                onLoadFolder={onLoadFolder}
                level={level + 1}
                parentPath={fullPath}
                getFileIcon={getFileIcon}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function getFileIcon(entry: Entry): React.ReactElement {
    if (entry.type === 'dir') {
      return <span className="text-blue-500"><Folder size={16} /></span>;
    }

    const ext = entry.path.split('.').pop()?.toLowerCase();
    const filename = entry.path.split('/').pop()?.toLowerCase();

    // Special files
    if (filename === 'package.json') return <span className="text-green-600"><Braces size={16} /></span>;
    if (filename === 'dockerfile') return <span className="text-blue-400"><Ship size={16} /></span>;
    if (filename?.startsWith('.env')) return <span className="text-yellow-500"><Lock size={16} /></span>;
    if (filename === 'readme.md') return <span className="text-slate-600"><FileText size={16} /></span>;
    if (filename?.includes('config')) return <span className="text-slate-500"><Settings size={16} /></span>;

    switch (ext) {
      case 'tsx':
        return <span className="text-cyan-400"><Atom size={16} /></span>;
      case 'ts':
        return <span className="text-blue-600"><Type size={16} /></span>;
      case 'jsx':
        return <span className="text-cyan-400"><Atom size={16} /></span>;
      case 'js':
      case 'mjs':
        return <span className="text-yellow-400"><Braces size={16} /></span>;
      case 'css':
        return <span className="text-blue-500"><Palette size={16} /></span>;
      case 'scss':
      case 'sass':
        return <span className="text-pink-500"><Palette size={16} /></span>;
      case 'html':
      case 'htm':
        return <span className="text-orange-500"><FileCode size={16} /></span>;
      case 'json':
        return <span className="text-yellow-600"><Braces size={16} /></span>;
      case 'md':
      case 'markdown':
        return <span className="text-slate-600"><FileText size={16} /></span>;
      case 'py':
        return <span className="text-blue-400"><Workflow size={16} /></span>;
      case 'sh':
      case 'bash':
        return <span className="text-green-500"><FileCode size={16} /></span>;
      case 'yaml':
      case 'yml':
        return <span className="text-red-500"><List size={16} /></span>;
      case 'xml':
        return <span className="text-orange-600"><FileCode size={16} /></span>;
      case 'sql':
        return <span className="text-blue-600"><Database size={16} /></span>;
      case 'php':
        return <span className="text-indigo-500"><Braces size={16} /></span>;
      case 'java':
        return <span className="text-red-600"><Coffee size={16} /></span>;
      case 'c':
        return <span className="text-blue-700"><FileCode size={16} /></span>;
      case 'cpp':
      case 'cc':
      case 'cxx':
        return <span className="text-blue-600"><Plus size={16} /></span>;
      case 'rs':
        return <span className="text-orange-700"><Settings size={16} /></span>;
      case 'go':
        return <span className="text-cyan-500"><Bird size={16} /></span>;
      case 'rb':
        return <span className="text-red-500"><Gem size={16} /></span>;
      case 'vue':
        return <span className="text-green-500"><Triangle size={16} /></span>;
      case 'svelte':
        return <span className="text-orange-600"><Flame size={16} /></span>;
      case 'dockerfile':
        return <span className="text-blue-400"><Ship size={16} /></span>;
      case 'toml':
      case 'ini':
      case 'conf':
      case 'config':
        return <span className="text-slate-500"><Settings size={16} /></span>;
      default:
        return <span className="text-slate-400"><File size={16} /></span>;
    }
  }
