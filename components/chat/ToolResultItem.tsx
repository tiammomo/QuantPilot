import React, { useId, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BookOpen,
  CheckSquare,
  Code2,
  FileText,
  FolderSearch,
  Search,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { toRelativePath } from '@/lib/utils/path';

type ToolAction = 'Edited' | 'Created' | 'Read' | 'Deleted' | 'Generated' | 'Searched' | 'Executed';

interface ToolResultItemProps {
  action: ToolAction;
  filePath?: string;
  content?: string;
  toolName?: string;
  input?: string;
  output?: string;
  status?: 'executing' | 'done';
  isExpanded?: boolean;
  onToggle?: (nextExpanded: boolean) => void;
}

const toolNameFromAction: Record<ToolAction, string> = {
  Edited: 'Edit',
  Created: 'Write',
  Read: 'Read',
  Deleted: 'Delete',
  Generated: 'Todo List',
  Searched: 'Glob',
  Executed: 'Bash',
};

const normalizeToolName = (toolName: string | undefined, action: ToolAction) => {
  const raw = (toolName || toolNameFromAction[action] || 'Tool').trim();
  const lower = raw.toLowerCase();

  if (lower.includes('skill')) return 'Skill';
  if (lower.includes('glob')) return 'Glob';
  if (lower.includes('grep')) return 'Grep';
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('run')) return 'Bash';
  if (lower.includes('read')) return 'Read';
  if (lower.includes('write') || lower.includes('create')) return 'Write';
  if (lower.includes('edit') || lower.includes('patch')) return 'Edit';
  if (lower.includes('todo') || lower.includes('plan')) return 'Todo List';
  if (lower.includes('search') || lower.includes('list') || lower === 'ls') return 'Glob';

  return raw
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
};

const getToolIcon = (toolName: string, action: ToolAction) => {
  const lower = toolName.toLowerCase();
  const className = 'h-3.5 w-3.5 text-slate-500';

  if (lower.includes('skill')) return <Wrench className={className} />;
  if (lower.includes('glob') || lower.includes('grep') || action === 'Searched') return <Search className={className} />;
  if (lower.includes('bash') || action === 'Executed') return <Terminal className={className} />;
  if (lower.includes('read') || action === 'Read') return <BookOpen className={className} />;
  if (lower.includes('todo') || lower.includes('plan') || action === 'Generated') return <CheckSquare className={className} />;
  if (action === 'Edited' || action === 'Created') return <Code2 className={className} />;
  return <FileText className={className} />;
};

const normalizeDisplayTarget = (value: string | undefined) => {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'Tool action' || /^Tool:\s*/i.test(trimmed)) return '';
  return toRelativePath(trimmed);
};

const DetailBlock = ({ title, value }: { title: string; value?: string }) => {
  if (!value) return null;

  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-indigo-700">{title}</div>
      <pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-900">
        {value}
      </pre>
    </div>
  );
};

const ToolResultItem: React.FC<ToolResultItemProps> = ({
  action,
  filePath,
  content,
  toolName,
  input,
  output,
  status = 'done',
  isExpanded: controlledExpanded,
  onToggle,
}) => {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'input' | 'output'>('input');
  const dialogTitleId = useId();
  const isControlled = typeof controlledExpanded === 'boolean';
  const isOpen = isControlled ? controlledExpanded : uncontrolledExpanded;
  const displayToolName = normalizeToolName(toolName, action);
  const displayTarget = normalizeDisplayTarget(filePath);
  const detailInput = input?.trim();
  const detailOutput = (output || content)?.trim();
  const hasDetail = Boolean(detailInput || detailOutput);

  const openDetails = () => {
    if (!hasDetail) return;
    setActiveTab(detailInput ? 'input' : 'output');
    if (!isControlled) {
      setUncontrolledExpanded(true);
    }
    onToggle?.(true);
  };

  const closeDetails = () => {
    if (!isControlled) {
      setUncontrolledExpanded(false);
    }
    onToggle?.(false);
  };

  return (
    <div className="mb-1.5">
      <button
        type="button"
        className={`group flex max-w-full items-center gap-1.5 text-left text-sm leading-6 text-slate-800 ${
          hasDetail ? 'cursor-pointer hover:text-slate-950' : 'cursor-default'
        }`}
        onClick={openDetails}
        aria-haspopup={hasDetail ? 'dialog' : undefined}
        aria-expanded={hasDetail ? isOpen : undefined}
        disabled={!hasDetail}
      >
        <span className="text-slate-400">•</span>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {getToolIcon(displayToolName, action)}
        </span>
        <span className="shrink-0 font-semibold text-slate-900">{displayToolName}</span>
        {status === 'executing' && (
          <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-slate-600">
            executing...
          </span>
        )}
        {displayTarget && (
          <code
            className="min-w-0 max-w-[min(42rem,70vw)] truncate rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700 group-hover:bg-slate-200"
            title={displayTarget}
          >
            {displayTarget}
          </code>
        )}
      </button>

      <AnimatePresence>
        {isOpen && hasDetail && (
          <motion.div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeDetails}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby={dialogTitleId}
              className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              onClick={(event: React.MouseEvent<HTMLDivElement>) => event.stopPropagation()}
            >
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-5">
                <h2 id={dialogTitleId} className="text-base font-semibold text-slate-950">
                  {displayToolName}
                </h2>
                <button
                  type="button"
                  onClick={closeDetails}
                  className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  aria-label="关闭工具详情"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex shrink-0 border-b border-slate-200 px-5">
                {(['input', 'output'] as const).map(tab => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`border-b-2 px-3 py-3 text-sm transition-colors ${
                      activeTab === tab
                        ? 'border-blue-600 font-medium text-blue-700'
                        : 'border-transparent text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    {tab === 'input' ? '输入' : '输出'}
                  </button>
                ))}
              </div>

              <div className="min-h-[260px] flex-1 space-y-5 overflow-auto px-5 py-5">
                {activeTab === 'input' ? (
                  <>
                    <DetailBlock title="args" value={detailInput} />
                    <div>
                      <div className="mb-2 text-xs font-semibold text-indigo-700">skill</div>
                      <div className="text-sm text-slate-900">{displayToolName}</div>
                    </div>
                  </>
                ) : detailOutput ? (
                  <DetailBlock title="output" value={detailOutput} />
                ) : (
                  <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
                    暂无输出，工具可能仍在执行中。
                  </div>
                )}
              </div>

              <div className="flex shrink-0 justify-end border-t border-slate-100 px-5 py-4">
                <button
                  type="button"
                  onClick={closeDetails}
                  className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
                >
                  关闭
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ToolResultItem;
