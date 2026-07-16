import { NextRequest, NextResponse } from 'next/server';

import { AuthorizationError, requireAdminSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getGenerationObservabilityDashboard } from '@/lib/quant/generation-observability';

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession(request.headers);
    const response = NextResponse.json({
      success: true,
      data: await getGenerationObservabilityDashboard(),
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return authErrorResponse(error);
    }
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
