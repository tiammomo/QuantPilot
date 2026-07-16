import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getGenerationObservabilityDashboard } from '@/lib/quant/generation-observability';

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.observability.read',
    });
    const url = new URL(request.url);
    const summaryOnly = url.searchParams.get('summary') === '1';
    const requestedEventLimit = Number.parseInt(url.searchParams.get('events') ?? '', 10);
    const dashboard = await getGenerationObservabilityDashboard({
      summaryOnly,
      eventLimit: Number.isFinite(requestedEventLimit) ? requestedEventLimit : undefined,
    });
    const response = NextResponse.json({
      success: true,
      data: dashboard,
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
