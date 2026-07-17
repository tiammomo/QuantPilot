import type { QuotaEnforcement, QuotaWindowType } from './types';

export const DEFAULT_QUOTA_PROFILE = Object.freeze({
  key: 'member-default',
  name: '普通成员',
  description: '请求前可判断的有限配额执行硬限制，结果型用量提醒；管理员保持无限。',
} as const);

export interface BuiltinQuotaRule {
  readonly metric: string;
  readonly limit: bigint;
  readonly enforcement: QuotaEnforcement;
  readonly windowType: QuotaWindowType;
  readonly windowSeconds: number | null;
  readonly reservationTtlSeconds: number;
}

/**
 * Product defaults used by migrations, empty-database bootstrap, and the
 * runtime fallback. Keep these values centralized so `prisma db push` and
 * `prisma migrate deploy` produce the same effective policy.
 */
export const DEFAULT_QUOTA_RULES = Object.freeze([
  {
    metric: 'projects.owned',
    limit: 10n,
    enforcement: 'hard',
    windowType: 'lifetime',
    windowSeconds: null,
    reservationTtlSeconds: 3_600,
  },
  {
    metric: 'agent.concurrent',
    limit: 2n,
    enforcement: 'hard',
    windowType: 'lifetime',
    windowSeconds: null,
    reservationTtlSeconds: 3_600,
  },
  {
    metric: 'agent.requests.daily',
    limit: 100n,
    enforcement: 'hard',
    windowType: 'day',
    windowSeconds: null,
    reservationTtlSeconds: 900,
  },
  {
    metric: 'llm.total_tokens.monthly',
    limit: 2_000_000n,
    enforcement: 'warn',
    windowType: 'month',
    windowSeconds: null,
    reservationTtlSeconds: 3_600,
  },
  {
    metric: 'query_rewrite.llm.daily',
    limit: 200n,
    enforcement: 'hard',
    windowType: 'day',
    windowSeconds: null,
    reservationTtlSeconds: 900,
  },
  {
    metric: 'quant.data_units.daily',
    limit: 2_000n,
    enforcement: 'warn',
    windowType: 'day',
    windowSeconds: null,
    reservationTtlSeconds: 900,
  },
  {
    metric: 'research.report_runs.daily',
    limit: 20n,
    enforcement: 'hard',
    windowType: 'day',
    windowSeconds: null,
    reservationTtlSeconds: 3_600,
  },
  {
    metric: 'research.report_sends.daily',
    limit: 10n,
    enforcement: 'hard',
    windowType: 'day',
    windowSeconds: null,
    reservationTtlSeconds: 3_600,
  },
] satisfies readonly BuiltinQuotaRule[]);

const DEFAULT_QUOTA_RULE_BY_METRIC = new Map(
  DEFAULT_QUOTA_RULES.map((rule) => [rule.metric, rule] as const),
);

export function getBuiltinQuotaRule(metric: string): BuiltinQuotaRule | undefined {
  return DEFAULT_QUOTA_RULE_BY_METRIC.get(metric);
}
