import React, { useId, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BookOpen,
  CheckSquare,
  CircleAlert,
  Code2,
  FileText,
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
  outputOriginalChars?: number;
  outputTruncated?: boolean;
  summary?: string;
  status?: 'executing' | 'done';
  success?: boolean;
  errorCode?: string;
  attemptCount?: number;
  recoveredFailureCount?: number;
  pathCorrected?: boolean;
  requestedPath?: string;
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

const typedToolDisplayNames: Record<string, string> = {
  'run-planner': '执行计划',
  query_json: '数据查询',
  query_text_file: '源码定位',
  inspect_dashboard_contract: '看板结构',
  apply_dashboard_spec: '看板编译',
  semantic_edit: '语义编辑',
  edit_file: '修改文件',
  write_file: '写入文件',
  submit_result: '提交结果',
  quant_api_get: '行情接口',
  extract_image_evidence: '图片识别',
};

const normalizeToolName = (toolName: string | undefined, action: ToolAction) => {
  const raw = (toolName || toolNameFromAction[action] || 'Tool').trim();
  const lower = raw.toLowerCase();

  if (typedToolDisplayNames[lower]) return typedToolDisplayNames[lower];
  if (/^quant-[a-z0-9-]+$/i.test(raw) || /^data-[a-z0-9-]+$/i.test(raw)) return raw;
  if (lower === 'skill' || lower === 'tool' || lower === 'tool_use') return 'Skill';
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

const getToolIcon = (toolName: string, action: ToolAction, success?: boolean) => {
  const lower = toolName.toLowerCase();
  const className = 'h-3.5 w-3.5 text-slate-500';

  if (success === false) return <CircleAlert className="h-3.5 w-3.5 text-amber-600" />;
  if (['数据查询', '源码定位', '看板结构'].includes(toolName)) return <BookOpen className={className} />;
  if (['执行计划', '提交结果'].includes(toolName)) return <CheckSquare className={className} />;
  if (['看板编译', '语义编辑'].includes(toolName)) return <Code2 className={className} />;
  if (lower.includes('skill') || /^quant-[a-z0-9-]+$/i.test(toolName)) return <Wrench className={className} />;
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

const tryParseJson = (value?: string): unknown => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const pickRecordString = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
};

const extractSkillNameFromJson = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const direct = pickRecordString(record, ['skill', 'skillName', 'skill_name', 'skillId', 'skill_id']);
  if (direct) return direct;
  const nested = record.args ?? record.input ?? record.toolInput ?? record.tool_input;
  return extractSkillNameFromJson(nested);
};

const describeCurlCommand = (command: string) => {
  const lower = command.toLowerCase();
  if (!lower.includes('curl')) return '';
  if (lower.includes('/api/v1/symbols/resolve')) return '解析股票名称或代码，确认后续取数标的。';
  if (lower.includes('/api/v1/quotes/realtime')) return '获取实时行情数据，确认最新价、涨跌幅和成交信息。';
  if (lower.includes('/api/v1/quotes/history')) return '获取历史 K 线和成交量数据，用于趋势、均线和量价分析。';
  if (lower.includes('/api/v1/indicators')) return '计算技术指标，补充均线、收益、回撤、波动率等分析字段。';
  if (lower.includes('/api/v1/fundamentals/financials')) return '获取财务报表数据，补充营收、利润、现金流和成长性。';
  if (lower.includes('/api/v1/fundamentals/indicators')) return '获取基本面指标，补充 ROE、毛利率、净利率和估值质量。';
  if (lower.includes('/api/v1/announcements')) return '获取公告和事件数据，补充行情变化的事件背景。';
  if (lower.includes('/api/market')) return '检查生成页面的同源行情代理是否可用。';
  return '调用本地行情后端获取真实数据。';
};

const describeFileTarget = (target: string, action: ToolAction) => {
  const normalized = target.replaceAll('\\', '/');
  if (!normalized) return '';
  if (normalized.endsWith('.quantpilot/run_plan.json')) return '记录本次分析计划、标的、数据需求和验收项。';
  if (normalized.endsWith('.quantpilot/events.jsonl')) return '追加可见执行事件，便于复盘每个阶段。';
  if (normalized.endsWith('evidence/sources.json')) return '记录数据来源、接口、抓取时间和来源说明。';
  if (normalized.endsWith('evidence/data_quality.json')) return '记录数据质量、缺失字段、异常和限制。';
  if (normalized.endsWith('data_file/final/dashboard-data.json')) return '写入最终看板数据，页面将基于它渲染图表。';
  if (normalized.endsWith('app/page.tsx')) return action === 'Read' ? '读取看板页面代码，确认当前渲染结构。' : '生成或更新量化可视化看板页面。';
  if (normalized.endsWith('app/globals.css')) return action === 'Read' ? '读取页面样式，确认图表和布局基础。' : '更新看板样式，保证布局、图表和响应式体验。';
  if (normalized.endsWith('next.config.js')) return '检查 Next.js 配置，确保预览和构建链路可用。';
  if (normalized.endsWith('package.json')) return '检查项目依赖和脚本，确保 build/dev 可执行。';
  if (normalized.includes('/api/market')) return '检查生成项目的行情代理接口。';
  return '';
};

const isLowValueText = (value?: string) => {
  const text = value?.trim();
  if (!text) return true;
  return (
    /^.+\s+已返回结果[，,]?\s*正在进入下一步处理。?$/i.test(text) ||
    /已返回结果[，,]?\s*正在进入下一步处理。?$/i.test(text) ||
    text === '读取项目文件，确认后续修改依据。' ||
    text === '写入项目产物，推进当前分析阶段。' ||
    text === '工具返回异常，需要根据错误信息调整后续步骤。' ||
    /^\(?Bash completed with no output\)?$/i.test(text) ||
    /^Using tool:\s*/i.test(text)
  );
};

const isLowValueCommand = (value?: string) => {
  const command = value?.trim();
  if (!command) return false;
  return (
    /^ls(\s|$)/i.test(command) ||
    /^pwd(\s|$)/i.test(command) ||
    /^mkdir\s+-p(\s|$)/i.test(command) ||
    /^find\s+.+\s+-maxdepth\s+\d+/i.test(command) ||
    /^test\s+-[efd]\s+/i.test(command) ||
    /^echo\s+/i.test(command) ||
    /^whoami(\s|$)/i.test(command)
  );
};

const countArrayValue = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = ['items', 'data', 'rows', 'klines', 'history', 'reports', 'points', 'announcements'];
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key].length;
    }
  }
  return 0;
};

const summarizeJsonOutput = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const name = pickRecordString(record, ['name', 'symbol_name']);
  const symbol = pickRecordString(record, ['symbol', 'code', 'secid']);
  const label = [name, symbol].filter(Boolean).join(' ');

  if ('price' in record || 'last_price' in record) {
    const price = pickRecordString(record, ['price', 'last_price', 'latest_price']);
    const change = pickRecordString(record, ['pct_chg', 'change_pct', 'change_percent', 'percent']);
    return `行情接口返回${label ? ` ${label}` : ''} 数据${price ? `，最新价 ${price}` : ''}${change ? `，涨跌幅 ${change}` : ''}。`;
  }

  const historyCount = countArrayValue(record.history ?? record.klines ?? record.items ?? record.data);
  if (historyCount > 0 && ('period' in record || 'adjustment' in record || 'klines' in record || 'history' in record)) {
    return `历史行情接口返回${label ? ` ${label}` : ''} ${historyCount} 条 K 线/成交量记录。`;
  }

  const reportCount = countArrayValue(record.reports);
  if (reportCount > 0) {
    return `财务接口返回${label ? ` ${label}` : ''} ${reportCount} 期报表数据。`;
  }

  const indicatorCount = countArrayValue(record.points);
  if (indicatorCount > 0) {
    return `指标接口返回${label ? ` ${label}` : ''} ${indicatorCount} 条指标数据。`;
  }

  const announcementCount = countArrayValue(record.announcements);
  if (announcementCount > 0) {
    return `公告接口返回${label ? ` ${label}` : ''} ${announcementCount} 条公告事件。`;
  }

  const status = pickRecordString(record, ['status']);
  if (status === 'ok' || status === 'success') {
    return '数据质量或验证结果通过。';
  }

  return '';
};

const buildToolSummary = ({
  displayToolName,
  action,
  target,
  input,
  output,
  summary,
  status,
  success,
  errorCode,
}: {
  displayToolName: string;
  action: ToolAction;
  target: string;
  input?: string;
  output?: string;
  summary?: string;
  status: 'executing' | 'done';
  success?: boolean;
  errorCode?: string;
}) => {
  const parsedInput = tryParseJson(input);
  const parsedOutput = tryParseJson(output);
  const trimmedSummary = summary?.trim();
  if (trimmedSummary && !isLowValueText(trimmedSummary)) return trimmedSummary;

  if (success === false) {
    if (errorCode === 'INVALID_TOOL_ARGUMENTS' || errorCode === 'INVALID_TOOL_INPUT') {
      return '参数格式需要调整，MoAgent 会根据工具契约重新组织调用。';
    }
    if (errorCode === 'PATH_NOT_FOUND' || errorCode === 'EDIT_MATCH_NOT_FOUND') {
      return '目标位置已经变化，需要重新定位后继续。';
    }
    return `本次调用未完成${errorCode ? `（${errorCode}）` : ''}，可展开查看诊断。`;
  }

  const outputSummary = summarizeJsonOutput(parsedOutput);
  if (outputSummary) return outputSummary;

  const skillName = extractSkillNameFromJson(parsedInput) || extractSkillNameFromJson(parsedOutput);
  const effectiveToolName = /^skill$/i.test(displayToolName) && skillName ? skillName : displayToolName;
  const lowerTool = effectiveToolName.toLowerCase();

  if (/^quant-[a-z0-9-]+$/i.test(effectiveToolName)) {
    if (lowerTool.includes('run-planner')) return '建立分析计划，明确标的、数据需求、看板模块和验证规则。';
    if (lowerTool.includes('symbol-resolver')) return '解析股票名称或代码，确保后续接口使用正确标的。';
    if (lowerTool.includes('market-data')) return '获取实时行情，补充最新价、涨跌幅、成交额和行情时间。';
    if (lowerTool.includes('a-share-history')) return '获取历史 K 线和成交量数据，为趋势与均线分析做准备。';
    if (lowerTool.includes('technical-indicators')) return '计算技术指标，形成均线、回撤、波动率和量价信号。';
    if (lowerTool.includes('fundamental')) return '获取财务和基本面数据，补充经营质量分析。';
    if (lowerTool.includes('announcement')) return '获取公告和事件信息，补充行情背景。';
    if (lowerTool.includes('data-quality')) return '检查数据覆盖率、缺失字段、来源和可用性。';
    if (lowerTool.includes('visualization')) return '基于最终数据生成可视化看板页面。';
    if (lowerTool.includes('comparison')) return '组织多标的对比数据，生成横向研究视角。';
    return '执行量化分析 skill，推进当前阶段。';
  }

  const curlSummary = describeCurlCommand(target);
  if (curlSummary) return curlSummary;

  const fileSummary = describeFileTarget(target, action);
  if (fileSummary) return fileSummary;

  if (action === 'Generated') return '更新任务清单，记录当前完成度和下一步。';
  if (status === 'executing') return '工具正在执行，等待结果返回。';
  return '';
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
  outputOriginalChars,
  outputTruncated = false,
  summary,
  status = 'done',
  success,
  errorCode,
  attemptCount,
  recoveredFailureCount = 0,
  pathCorrected = false,
  requestedPath,
  isExpanded: controlledExpanded,
  onToggle,
}) => {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'input' | 'output'>('output');
  const dialogTitleId = useId();
  const isControlled = typeof controlledExpanded === 'boolean';
  const isOpen = isControlled ? controlledExpanded : uncontrolledExpanded;
  const displayToolName = normalizeToolName(toolName, action);
  const displayTarget = normalizeDisplayTarget(filePath);
  const detailInput = input?.trim();
  const rawDetailOutput = (output || content)?.trim();
  const detailOutput = isLowValueText(rawDetailOutput) ? undefined : rawDetailOutput;
  const hasDetail = Boolean(detailInput || detailOutput);
  const toolSummary = buildToolSummary({
    displayToolName,
    action,
    target: displayTarget,
    input: detailInput,
    output: detailOutput,
    summary,
    status,
    success,
    errorCode,
  });
  const genericToolWithoutTarget = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(displayToolName);

  if (
    status === 'done' &&
    genericToolWithoutTarget &&
    (!displayTarget || isLowValueCommand(displayTarget)) &&
    !toolSummary
  ) {
    return null;
  }

  const openDetails = () => {
    if (!hasDetail) return;
    setActiveTab(detailOutput ? 'output' : 'input');
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
          {getToolIcon(displayToolName, action, success)}
        </span>
        <span className="shrink-0 font-semibold text-slate-900">{displayToolName}</span>
        {status === 'executing' && (
          <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-slate-600">
            executing...
          </span>
        )}
        {status === 'done' && success === false && (
          <span className="shrink-0 font-mono text-[11px] leading-4 text-amber-700">
            待恢复
          </span>
        )}
        {status === 'done' && success === true && (
          <span className="shrink-0 text-[11px] font-medium leading-4 text-emerald-700">
            已完成
          </span>
        )}
        {status === 'done' && success !== false && attemptCount !== undefined && attemptCount > 1 && (
          <span
            className="shrink-0 text-[11px] leading-4 text-slate-500"
            title={recoveredFailureCount > 0 ? `运行时已自动吸收 ${recoveredFailureCount} 次失败尝试` : undefined}
          >
            合并 {attemptCount} 组
          </span>
        )}
        {status === 'done' && success !== false && pathCorrected && (
          <span
            className="shrink-0 text-[11px] leading-4 text-emerald-700"
            title={requestedPath ? `原请求：${requestedPath}` : undefined}
          >
            已纠正
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
      {toolSummary && (
        <div className="ml-[3.05rem] mt-0.5 max-w-[min(46rem,76vw)] text-sm leading-6 text-slate-700">
          {toolSummary}
        </div>
      )}

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
                {activeTab === 'output' && outputTruncated && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                    输出过长，已保留开头和末尾诊断信息
                    {outputOriginalChars ? `（原始 ${outputOriginalChars.toLocaleString()} 个字符）` : ''}。
                  </div>
                )}
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
