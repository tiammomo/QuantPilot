import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getSupabaseProject } from '@/lib/services/supabase';

interface RouteContext {
  params: Promise<{ supabase_project_id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.tokens.manage',
    });
    const { supabase_project_id } = await params;
    const project = await getSupabaseProject(supabase_project_id);
    const response = NextResponse.json({ success: true, project });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to fetch Supabase project:', error);
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch Supabase project',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
