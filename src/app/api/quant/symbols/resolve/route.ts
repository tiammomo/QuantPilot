import { NextRequest, NextResponse } from 'next/server';

const MARKET_API_BASE_URL = (
  process.env.QUANTPILOT_MARKET_API_URL ?? 'http://127.0.0.1:8000'
).replace(/\/$/, '');

export async function GET(request: NextRequest) {
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
