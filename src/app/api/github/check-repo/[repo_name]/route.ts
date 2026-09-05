import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { validateRepositoryName } from '@/lib/integrations/github-repository';
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
    const validationError = validateRepositoryName(repo_name);
    if (validationError) {
      return NextResponse.json(
        { available: false, error: validationError },
        { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    const result = await checkRepositoryAvailability(repo_name);
    if (result.exists) {
      return NextResponse.json(
        { available: false, username: result.username },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    return NextResponse.json(
      { available: true, username: result.username },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to check repository availability:', error);
    const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to check repository availability',
        message: status < 500 && error instanceof Error ? error.message : 'GitHub is temporarily unavailable',
      },
      { status, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
