export const MOAGENT_TURN_METRICS_SCHEMA_VERSION = 1 as const;

export type MoAgentTokenAccounting =
  | 'provider'
  | 'estimated'
  | 'mixed'
  | 'partial';

export interface MoAgentTurnMetrics {
  schemaVersion: typeof MOAGENT_TURN_METRICS_SCHEMA_VERSION;
  elapsedMs: number;
  agentRunCount: number;
  modelTurnCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheMissInputTokens: number;
  reasoningTokens: number;
  tokenAccounting: MoAgentTokenAccounting;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseMoAgentTurnMetrics(value: unknown): MoAgentTurnMetrics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== MOAGENT_TURN_METRICS_SCHEMA_VERSION) return null;

  const numericKeys = [
    'elapsedMs',
    'agentRunCount',
    'modelTurnCount',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'cacheMissInputTokens',
    'reasoningTokens',
  ] as const;
  if (numericKeys.some((key) => !isNonNegativeSafeInteger(candidate[key]))) {
    return null;
  }

  const tokenAccounting = candidate.tokenAccounting;
  if (
    tokenAccounting !== 'provider' &&
    tokenAccounting !== 'estimated' &&
    tokenAccounting !== 'mixed' &&
    tokenAccounting !== 'partial'
  ) {
    return null;
  }

  const metrics: MoAgentTurnMetrics = {
    schemaVersion: MOAGENT_TURN_METRICS_SCHEMA_VERSION,
    elapsedMs: candidate.elapsedMs as number,
    agentRunCount: candidate.agentRunCount as number,
    modelTurnCount: candidate.modelTurnCount as number,
    inputTokens: candidate.inputTokens as number,
    outputTokens: candidate.outputTokens as number,
    totalTokens: candidate.totalTokens as number,
    cachedInputTokens: candidate.cachedInputTokens as number,
    cacheMissInputTokens: candidate.cacheMissInputTokens as number,
    reasoningTokens: candidate.reasoningTokens as number,
    tokenAccounting,
  };
  if (metrics.inputTokens + metrics.outputTokens !== metrics.totalTokens) return null;
  if (
    metrics.cachedInputTokens + metrics.cacheMissInputTokens !==
    metrics.inputTokens
  ) {
    return null;
  }
  if (metrics.reasoningTokens > metrics.outputTokens) return null;
  return metrics;
}

export function formatMoAgentDuration(elapsedMs: number): string {
  if (!isNonNegativeSafeInteger(elapsedMs)) return '未知';
  if (elapsedMs < 1_000) return '<1 秒';

  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds} 秒`;

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`;
}

export function formatMoAgentTokens(tokens: number): string {
  if (!isNonNegativeSafeInteger(tokens)) return '未知';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(tokens);
}
