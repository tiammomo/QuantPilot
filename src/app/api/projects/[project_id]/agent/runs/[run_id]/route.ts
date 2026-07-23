import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { readMoAgentRunTimeline } from '@/lib/services/moagent-tool-approval-store';

interface RouteContext {
  params: Promise<{ project_id: string; run_id: string }>;
}

function nonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { project_id, run_id } = await params;
    await requireAction({
      headers: request.headers,
      action: 'project.read',
      projectId: project_id,
    });
    const url = new URL(request.url);
    const data = await readMoAgentRunTimeline({
      projectId: project_id,
      runId: run_id,
      afterSequence: nonNegativeInteger(url.searchParams.get('afterSequence'), 0),
      limit: nonNegativeInteger(url.searchParams.get('limit'), 200),
    });
    if (!data) {
      return NextResponse.json(
        { success: false, error: 'AGENT_RUN_NOT_FOUND' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to read MoAgent run timeline:', error);
    return NextResponse.json(
      { success: false, error: 'FAILED_TO_READ_AGENT_RUN' },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
