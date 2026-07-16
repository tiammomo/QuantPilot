import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getInfrastructureHealth } from '@/lib/ops/infrastructure-health';

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.observability.read',
    });
    const result = await getInfrastructureHealth();
    const response = NextResponse.json(
      {
        success: result.success,
        data: result.data,
        error: result.error,
      },
      { status: result.status }
    );
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return NextResponse.json(
      { success: false, error: 'Failed to inspect infrastructure health' },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
