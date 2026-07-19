import type { PersonalMemoryPreferenceKey, PersonalMemoryScope } from './candidate-types';

export const PERSONAL_MEMORY_CANDIDATE_CONTRACT =
  'quantpilot-personal-memory-candidate/v1' as const;

export interface PersonalMemoryCandidate {
  contract: typeof PERSONAL_MEMORY_CANDIDATE_CONTRACT;
  key: PersonalMemoryPreferenceKey;
  value: string;
  scope: PersonalMemoryScope;
  reason: string;
}

const STABLE_INTENT = /(?:以后|今后|后续|从现在起|每次|默认|始终|一直|总是|请记住|帮我记住|我的偏好是|我(?:更)?偏好|我(?:更)?喜欢|回答时|输出时|分析时|研究时)/;
const EPHEMERAL_ONLY = /^(?:这次|本次|这一轮|当前任务|今天|现在)(?!以后|起)/;
const CONTROL_OR_TRADING = /(?:授权|权限|角色|管理员|密码|口令|token|令牌|密钥|secret|绕过|忽略风控|自动交易|自动下单|自动买|自动卖|代我交易|买入|卖出|仓位|止损|止盈)/i;

const CLASSIFIERS: ReadonlyArray<{
  key: PersonalMemoryPreferenceKey;
  reason: string;
  pattern: RegExp;
}> = [
  {
    key: 'analysis.risk_style',
    reason: '识别到稳定的风险表达偏好',
    pattern: /(?:风险|不确定性|回撤|风险提示|风险因素|谨慎|保守)/,
  },
  {
    key: 'research.evidence_style',
    reason: '识别到稳定的证据与数据时点偏好',
    pattern: /(?:证据|出处|来源|引用|数据时点|数据日期|可验证|可信度)/,
  },
  {
    key: 'output.detail_level',
    reason: '识别到稳定的回答详略偏好',
    pattern: /(?:简洁|简短|精简|详细|详尽|展开说明|篇幅|字数)/,
  },
  {
    key: 'output.visual_style',
    reason: '识别到稳定的图表与呈现偏好',
    pattern: /(?:图表|可视化|表格|K线|图形|仪表盘|看板呈现)/i,
  },
  {
    key: 'research.default_horizon',
    reason: '识别到稳定的研究周期偏好',
    pattern: /(?:(?:研究|分析|投资|持有).{0,8}(?:周期|期限)|短线|中线|长线|日内|周线|月线)/,
  },
  {
    key: 'analysis.default_market',
    reason: '识别到稳定的默认市场偏好',
    pattern: /(?:A股|港股|美股|沪深|纳斯达克|中国市场|香港市场|美国市场)/i,
  },
  {
    key: 'output.answer_style',
    reason: '识别到稳定的回答结构偏好',
    pattern: /(?:先.{0,12}(?:结论|摘要)|回答.{0,12}(?:结构|格式)|分点|条列|结论先行|先说结论|先.+再.+)/,
  },
];

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Finds only high-confidence, low-risk personalization candidates. This is a
 * local UX hint: detection never writes to the independent Memory service.
 */
export function detectPersonalMemoryCandidate(instruction: string): PersonalMemoryCandidate | null {
  const value = normalizedText(instruction);
  if (
    value.length < 4
    || value.length > 1_024
    || !STABLE_INTENT.test(value)
    || EPHEMERAL_ONLY.test(value)
    || CONTROL_OR_TRADING.test(value)
  ) {
    return null;
  }

  const classifier = CLASSIFIERS.find((candidate) => candidate.pattern.test(value));
  if (!classifier) return null;

  return {
    contract: PERSONAL_MEMORY_CANDIDATE_CONTRACT,
    key: classifier.key,
    value,
    scope: 'project',
    reason: classifier.reason,
  };
}
