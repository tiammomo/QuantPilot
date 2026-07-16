import type {
  QuotaCounterSnapshot,
  QuotaEnforcement,
  ResolvedQuotaPolicy,
} from './types';

const METRIC_PATTERN = /^[a-z][a-z0-9_.:-]{0,159}$/;

export function assertQuotaMetric(metric: string): void {
  if (!METRIC_PATTERN.test(metric)) {
    throw new TypeError('Quota metric must be a lowercase, namespaced identifier.');
  }
}

export function quotaQuantity(
  value: bigint | number | string,
  options: { allowZero?: boolean } = {},
): bigint {
  let quantity: bigint;
  if (typeof value === 'bigint') {
    quantity = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Quota quantity must be a safe integer.');
    quantity = BigInt(value);
  } else if (/^\d+$/.test(value)) {
    quantity = BigInt(value);
  } else {
    throw new TypeError('Quota quantity must be a non-negative integer.');
  }

  const minimum = options.allowZero ? 0n : 1n;
  if (quantity < minimum) {
    throw new TypeError(options.allowZero
      ? 'Quota quantity cannot be negative.'
      : 'Quota quantity must be greater than zero.');
  }
  return quantity;
}

export function quotaSignedQuantity(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Quota quantity must be a safe integer.');
    return BigInt(value);
  }
  if (/^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError('Quota quantity must be an integer.');
}

export function quotaEnforcement(value: string): QuotaEnforcement {
  if (value === 'warn' || value === 'hard') return value;
  return 'observe';
}

export function evaluateQuotaAttempt(
  policy: Pick<ResolvedQuotaPolicy, 'limit' | 'unlimited' | 'enforcement'>,
  used: bigint,
  reserved: bigint,
  requested: bigint,
): { allowed: boolean; counter: QuotaCounterSnapshot } {
  const limit = policy.unlimited ? null : policy.limit;
  const projected = used + reserved + requested;
  const exceeded = limit !== null && projected > limit;
  return {
    allowed: !exceeded || policy.enforcement !== 'hard',
    counter: {
      used,
      reserved,
      requested,
      limit,
      remaining: limit === null ? null : (limit > projected ? limit - projected : 0n),
      exceeded,
    },
  };
}
