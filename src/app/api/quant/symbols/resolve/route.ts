import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { authErrorResponse } from '@/lib/auth/http';
import { consumeQuota, quotaErrorResponse } from '@/lib/quota';

const MARKET_API_BASE_URL = (
  process.env.QUANTPILOT_MARKET_API_URL ?? 'http://127.0.0.1:8000'
).replace(/\/$/, '');

export async function GET(request: NextRequest) {
  let context: Awaited<ReturnType<typeof requireAction>>;
  try {
    context = await requireAction({ headers: request.headers, action: 'quant.data.read' });
  } catch (error) {
    return authErrorResponse(error);
  }
  const query = request.nextUrl.searchParams.get('query')?.normalize('NFKC').trim() ?? '';
  const requestedCount = Number.parseInt(request.nextUrl.searchParams.get('count') ?? '3', 10);
  const count = Number.isFinite(requestedCount)
    ? Math.min(5, Math.max(1, requestedCount))
    : 3;

  if (query.length < 2 || query.length > 64) {
    return NextResponse.json(
      { success: false, error: '证券名称或代码长度必须在 2 到 64 个字符之间。' },
      { status: 400 },
    );
  }

  if (context.session) {
    const requestId = randomUUID();
    try {
      await consumeQuota({
        actorUserId: context.session.user.id,
        metric: 'quant.data_units.daily',
        quantity: 1,
        idempotencyKey: `symbol-resolve:${context.session.user.id}:${requestId}`,
        sourceType: 'symbol_resolve',
        sourceId: requestId,
        usageEventIdempotencyKey: `symbol-resolve:${context.session.user.id}:${requestId}:usage`,
      });
    } catch (error) {
      return quotaErrorResponse(error) ?? NextResponse.json(
        { success: false, error: '暂时无法确认数据配额，请稍后重试。' },
        { status: 503 },
      );
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_500);
  try {
    const url = new URL('/api/v1/symbols/resolve', MARKET_API_BASE_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('count', String(count));
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: '暂时无法解析证券标的。', detail: payload },
        { status: response.status },
      );
    }
    return NextResponse.json({ success: true, data: payload });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return NextResponse.json(
      { success: false, error: timedOut ? '证券解析超时，请稍后重试。' : '证券解析服务暂不可用。' },
      { status: 503 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
