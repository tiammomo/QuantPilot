import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getOpsPlatformDashboard } from '@/lib/ops/ops-platform';

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.observability.read',
    });
    const url = new URL(request.url);
    const includeLogEntries = url.searchParams.get('includeLogs') === '1';
    const response = NextResponse.json({
      success: true,
      data: await getOpsPlatformDashboard({ includeLogEntries }),
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      const response = authErrorResponse(error);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    }
    return NextResponse.json(
      {
        success: false,
        error: '运行治理数据暂不可用，请稍后重试。',
      },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
