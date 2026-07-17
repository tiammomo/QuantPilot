import {
  extractExplicitSymbolCodes,
  matchKnownSymbolAliases,
} from '@/lib/quant/symbol-aliases';

export type QuestionMode = 'act' | 'chat';

export const QUESTION_MODE_COPY: Record<QuestionMode, {
  label: string;
  description: string;
  outputLabel: string;
}> = {
  act: {
    label: '生成看板',
    description: '获取真实数据并生成可交付看板',
    outputLabel: '生成交互看板',
  },
  chat: {
    label: '只做问答',
    description: '只回答问题，不修改当前看板',
    outputLabel: '只做分析问答',
  },
};

export const QUESTION_COMPOSER_COPY = {
  defaultPlaceholder: '向 QuantPilot 描述你的量化需求...',
  runningPlaceholder: '补充要求将在当前任务结束后自动执行…',
  recognitionTitle: '发送前识别',
  recognitionHelper: '可直接发送，系统仍会做正式核验',
  resolvingTarget: '正在识别标的',
  pendingTargetVerification: '待执行时确认',
  advancedSettings: '高级',
  advancedSettingsDescription: '执行引擎与模型设置',
} as const;

const CHAT_ONLY_EXECUTION_CONSTRAINT = "Do not modify code or generate a dashboard. Only answer the user's request with evidence.";

export function buildQuestionInstruction(question: string, mode: QuestionMode): string {
  const visibleQuestion = question.trim();
  return mode === 'chat'
    ? `${visibleQuestion}\n\n${CHAT_ONLY_EXECUTION_CONSTRAINT}`
    : visibleQuestion;
}

const LEADING_REQUEST_WORDS = /^(?:(?:请|麻烦)?(?:帮我|给我)?(?:看一下|看看|分析一下|分析|研究一下|研究|评估一下|评估|梳理一下|梳理)|我想(?:看看|了解|分析)?|想(?:看看|了解|分析)?)+/u;
const SUBJECT_BOUNDARY = /(?:的(?:股票|个股)|这(?:只|个)?(?:股票|个股)|股票|个股|最近|近\s*[一二两三四五六七八九十百\d]|过去|今日|今天|昨日|今年|本周|本月|怎么样|如何|走势|行情|财务|基本面|技术|风险|公告|估值|回测|策略|对比|比较)/u;

function boundedText(value: string, maxLength = 24): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeSubjectCandidate(value: string): string | null {
  let candidate = value
    .normalize('NFKC')
    .split(/[，,。！？?；;\n]/u, 1)[0]
    .trim()
    .replace(LEADING_REQUEST_WORDS, '')
    .trim();
  candidate = candidate.split(SUBJECT_BOUNDARY, 1)[0].replace(/^(?:一下|一下子)/u, '').trim();
  candidate = candidate.replace(/(?:这个|这只|的)$/u, '').trim();
  if (!candidate || candidate.length < 2 || candidate.length > 24) return null;
  if (!/[\p{Script=Han}A-Za-z]/u.test(candidate)) return null;
  return candidate;
}

export function inferSymbolSearchQuery(
  question: string,
  projectName = '',
): string | null {
  const explicitCode = extractExplicitSymbolCodes(question)[0];
  if (explicitCode) return explicitCode;

  const knownAlias = matchKnownSymbolAliases(question)[0];
  if (knownAlias) return knownAlias.keyword;

  return normalizeSubjectCandidate(question) ?? normalizeSubjectCandidate(projectName);
}

export function inferQuestionTimeRange(question: string): string {
  const normalized = question.normalize('NFKC');
  const relative = normalized.match(
    /(?:最近|近|过去)\s*([一二两三四五六七八九十百半\d]+)\s*(个)?\s*(交易日|日|天|周|月|季度|年)/u,
  );
  if (relative) return boundedText(`近${relative[1]}${relative[3]}`);
  if (/(?:今日|今天|当日)/u.test(normalized)) return '今日';
  if (/(?:昨日|昨天)/u.test(normalized)) return '昨日';
  if (/本周/u.test(normalized)) return '本周';
  if (/本月/u.test(normalized)) return '本月';
  if (/今年/u.test(normalized)) return '今年';

  const years = normalized.match(/(20\d{2})\s*(?:年|[-/.])\s*(?:至|到|-|~)\s*(20\d{2})/u);
  if (years) return `${years[1]}–${years[2]}`;
  return '平台默认周期';
}

export function inferQuestionFocus(question: string): string {
  const normalized = question.normalize('NFKC');
  if (/(?:回测|策略|胜率|收益率|最大回撤|交易明细)/u.test(normalized)) return '策略回测';
  if (/(?:对比|比较|谁更|排名|横向)/u.test(normalized)) return '标的对比';
  if (/(?:财务|基本面|估值|营收|利润|现金流|ROE|PE|PB)/iu.test(normalized)) return '财务质量';
  if (/(?:公告|事件|分红|减持|增持|业绩预告)/u.test(normalized)) return '公告事件';
  if (/(?:技术|趋势|K\s*线|均线|量能|成交量|波动|支撑|压力)/iu.test(normalized)) return '趋势与风险';
  if (/(?:持仓|组合|仓位|成本|调仓)/u.test(normalized)) return '组合风险';
  return '综合诊断';
}

export function questionOutputLabel(mode: QuestionMode): string {
  return QUESTION_MODE_COPY[mode].outputLabel;
}

export function buildQuickQuestions(projectName = ''): string[] {
  const subject = normalizeSubjectCandidate(projectName) ?? '当前标的';
  return [
    `分析${subject}近60个交易日的趋势、量能和主要风险`,
    `评估${subject}的财务质量、估值位置和关键风险`,
    `梳理${subject}近期重要公告及其潜在影响`,
    `对${subject}做一个均线策略回测并说明适用边界`,
  ];
}
