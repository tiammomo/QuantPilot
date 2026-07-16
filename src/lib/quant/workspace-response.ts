import { getQuantCapability } from '@/lib/quant/capabilities';
import type { QuantRunPlan } from '@/lib/quant/workspace';

export const WORKSPACE_PROGRESS_TOTAL = 5 as const;

export const WORKSPACE_PROGRESS_STAGE_LABELS = [
  '正在理解问题',
  '正在准备数据与证据',
  '正在分析并生成工作区',
  '正在执行平台校验',
  '已完成/未完成',
] as const;

export type WorkspaceProgressStage = 1 | 2 | 3 | 4 | 5;

export type WorkspaceProgressOptions = {
  stage: WorkspaceProgressStage;
  runPlan?: QuantRunPlan | null;
  skillIds?: string[];
  previewUrl?: string;
  validationCheckCount?: number;
  validationWarningCount?: number;
  failureReason?: string;
  cancelledReason?: string;
};

const OPERATIONAL_MARKERS = [
  '请默认使用中文输出可见的执行过程摘要。',
  'Visible process instructions',
  '可见过程叙述要求',
  '平台执行要求',
] as const;

function boundedText(value: string | null | undefined, maxLength = 160): string {
  const normalized = (value ?? '').replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function stripOperationalSuffix(value: string): string {
  let result = value.trim();
  for (const marker of OPERATIONAL_MARKERS) {
    const markerIndex = result.indexOf(marker);
    if (markerIndex >= 0) result = result.slice(0, markerIndex).trim();
  }
  return result;
}

function markdownCell(value: string): string {
  return boundedText(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function hasExplicitTime(question: string): boolean {
  return /(?:20\d{2}[-/.年]|(?:最近|近|过去)\s*(?:\d+|一|两|三|半)\s*(?:个)?(?:交易日|日|天|周|月|年|季度|报告期)|今日|今天|昨日|本周|本月|本季|今年|\d+\s*(?:个)?(?:交易日|日|天|周|月|年|季度|报告期)|截至)/i.test(question);
}

function inferGranularity(runPlan: QuantRunPlan, capabilityId: string): string {
  const source = `${runPlan.timeRange ?? ''} ${runPlan.dataRequirements.join(' ')}`;
  if (/(?:分钟|分时|小时)/.test(source)) return '分钟/分时';
  if (/(?:报告期|季度|财务|基本面)/.test(source) || capabilityId === 'fundamental_analysis') {
    return '报告期';
  }
  if (/(?:交易日|日线|K\s*线|行情|走势|回测|年|月|周)/i.test(source)) return '日';
  return '不适用';
}

function listSummary(values: string[] | undefined, fallback: string, limit = 4): string {
  const normalized = (values ?? []).map((value) => boundedText(value, 42)).filter(Boolean);
  if (normalized.length === 0) return fallback;
  const selected = normalized.slice(0, limit);
  return `${selected.join('、')}${normalized.length > selected.length ? ` 等 ${normalized.length} 项` : ''}`;
}

function recognitionTable(runPlan: QuantRunPlan): string {
  const capability = getQuantCapability(runPlan.requestedCapabilityId ?? runPlan.capabilityId);
  const question = stripOperationalSuffix(runPlan.question);
  const object = runPlan.symbols.length > 0
    ? runPlan.symbols.join('、')
    : runPlan.visualization.templateId === 'stock-selection'
      ? 'A 股股票池'
      : '待从问题或附件确认';
  const timeRange = runPlan.timeRange ?? '未指定';
  const timeStatus = runPlan.timeRange
    ? hasExplicitTime(question) ? '明确' : '平台默认'
    : '不适用';
  const granularity = inferGranularity(runPlan, capability.id);
  const analysisView = runPlan.visualization.variantName ??
    runPlan.visualization.name ??
    capability.name;
  const output = runPlan.visualization.required ? '交互式金融看板' : '结构化分析';

  const rows = [
    ['业务场景', capability.name, '明确'],
    ['分析对象', object, runPlan.symbols.length > 0 || runPlan.visualization.templateId === 'stock-selection' ? '明确' : '待确认'],
    ['时间范围', timeRange, timeStatus],
    ['时间粒度', granularity, granularity === '不适用' ? '不适用' : '明确'],
    ['核心数据/指标', listSummary(runPlan.dataRequirements, '按任务合同核验'), '明确'],
    ['分析维度', analysisView, analysisView ? '明确' : '不适用'],
    ['输出形式', output, '明确'],
  ];

  return [
    '| 维度 | 初步识别 | 状态 |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.map((value) => markdownCell(value)).join(' | ')} |`),
  ].join('\n');
}

function stageTwoMessage(runPlan: QuantRunPlan | null | undefined, skillIds: string[]): string {
  const symbols = runPlan?.symbols.length ? runPlan.symbols.join('、') : '任务对象';
  const timeRange = runPlan?.timeRange ?? '任务要求的时间范围';
  const skills = listSummary(skillIds, '按任务合同选择', 6);
  return [
    `正在按 ${boundedText(symbols, 80)}、${boundedText(timeRange, 80)} 核验本地数据覆盖、真实信源和字段完整性。`,
    '',
    `当前 Skills：${skills}。`,
  ].join('\n');
}

export function buildWorkspaceProgressMessage(options: WorkspaceProgressOptions): string {
  switch (options.stage) {
    case 1: {
      if (!options.runPlan) {
        return `**【进度 1/5】${WORKSPACE_PROGRESS_STAGE_LABELS[0]}**\n\n正在建立任务合同并识别分析对象、时间范围、数据需求和输出形式。`;
      }
      const question = boundedText(stripOperationalSuffix(options.runPlan.question), 240);
      return [
        `**【进度 1/5】${WORKSPACE_PROGRESS_STAGE_LABELS[0]}**`,
        '',
        recognitionTable(options.runPlan),
        '',
        `用户原问句：${question || '未提供文字问题'}`,
        '',
        options.runPlan.status === 'needs_clarification'
          ? '初步识别发现关键输入仍不唯一，先完成必要澄清，再进入数据核验。'
          : '已完成初步语义识别，开始核验真实数据和任务合同。',
      ].join('\n');
    }
    case 2:
      return [
        `**【进度 2/5】${WORKSPACE_PROGRESS_STAGE_LABELS[1]}**`,
        '',
        stageTwoMessage(options.runPlan, options.skillIds ?? []),
      ].join('\n');
    case 3:
      return [
        `**【进度 3/5】${WORKSPACE_PROGRESS_STAGE_LABELS[2]}**`,
        '',
        '开始基于任务合同、已获取数据与可用 Skills 生成工作区；缺失字段会继续补齐或明确标注。',
        ...(options.skillIds?.length
          ? ['', `当前 Skills：${listSummary(options.skillIds, '按任务合同选择', 6)}。`]
          : []),
      ].join('\n');
    case 4:
      return [
        `**【进度 4/5】${WORKSPACE_PROGRESS_STAGE_LABELS[3]}**`,
        '',
        '正在检查构建、数据绑定、证据文件、图表、响应式布局和持久预览；失败项会进入受限修复。',
      ].join('\n');
    case 5: {
      if (options.cancelledReason) {
        return [
          '**【进度 5/5】已暂停**',
          '',
          '请求已暂停，当前候选不会被投影为完成态。',
          '',
          `原因：${boundedText(options.cancelledReason, 320)}`,
        ].join('\n');
      }
      if (options.failureReason) {
        return [
          '**【进度 5/5】未完成**',
          '',
          '当前候选未通过生产完成条件，未投影为可交付结果。',
          '',
          `原因：${boundedText(options.failureReason, 320)}`,
        ].join('\n');
      }
      const details = [
        options.validationCheckCount !== undefined
          ? `- 自动校验：${options.validationCheckCount} 项检查完成${
              options.validationWarningCount
                ? `（${options.validationWarningCount} 项提示）`
                : '，无阻断项'
            }`
          : '- 自动校验：通过',
        '- 独立证据验收：通过',
        options.previewUrl ? `- 持久预览：${boundedText(options.previewUrl, 240)}` : '- 持久预览：已就绪',
      ];
      return [
        '**【进度 5/5】已完成**',
        '',
        '工作区已生成，并通过平台自动校验与独立证据验收。',
        '',
        ...details,
      ].join('\n');
    }
  }
}
