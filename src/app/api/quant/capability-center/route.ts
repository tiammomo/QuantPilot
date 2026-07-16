import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getCapabilityCenterData } from '@/lib/quant/capability-center';

export async function GET(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'quant.data.read' });
    return NextResponse.json({
      success: true,
      data: await getCapabilityCenterData(),
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
