import { NextResponse } from 'next/server';

import { QuotaError, QuotaExceededError } from './service';

export function quotaErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof QuotaExceededError) {
    const { decision } = error;
    const retryAfter = Math.max(
      1,
      Math.ceil((decision.window.end.getTime() - Date.now()) / 1_000),
    );
    return NextResponse.json(
      {
        success: false,
        error: error.code,
        message: '当前操作会超过可用配额，请等待额度重置或联系管理员调整策略。',
        quota: {
          metric: decision.policy.metric,
          enforcement: decision.policy.enforcement,
          used: decision.counter.used.toString(),
          reserved: decision.counter.reserved.toString(),
          requested: decision.counter.requested.toString(),
          limit: decision.counter.limit?.toString() ?? null,
          remaining: decision.counter.remaining?.toString() ?? null,
          resetAt: decision.window.end.toISOString(),
        },
      },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      },
    );
  }
  if (error instanceof QuotaError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return null;
}
