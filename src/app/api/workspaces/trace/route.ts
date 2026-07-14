import { NextResponse } from 'next/server';
import { getGenerationObservabilityDashboard } from '@/lib/quant/generation-observability';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const summaryOnly = url.searchParams.get('summary') === '1';
    const requestedEventLimit = Number.parseInt(url.searchParams.get('events') ?? '', 10);
    const dashboard = await getGenerationObservabilityDashboard({
      summaryOnly,
      eventLimit: Number.isFinite(requestedEventLimit) ? requestedEventLimit : undefined,
    });
    return NextResponse.json({
      success: true,
      data: dashboard,
    });
  } catch (error) {
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
