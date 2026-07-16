import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { checkRepositoryAvailability } from '@/lib/services/github';

interface RouteContext {
  params: Promise<{ repo_name: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.tokens.manage',
    });
    const { repo_name } = await params;
    const result = await checkRepositoryAvailability(repo_name);
    if (result.exists) {
      return NextResponse.json({ available: false, username: result.username }, { status: 409 });
    }
    return NextResponse.json({ available: true, username: result.username });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to check repository availability:', error);
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to check repository availability',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
