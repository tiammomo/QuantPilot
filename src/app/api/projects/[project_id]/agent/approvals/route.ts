import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import {
  listMoAgentToolApprovals,
  MoAgentToolApprovalStoreError,
} from '@/lib/services/moagent-tool-approval-store';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const STATUSES = new Set(['pending', 'approved', 'edited', 'rejected', 'expired']);

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: 'project.read',
      projectId: project_id,
    });
    const url = new URL(request.url);
    const statusValue = url.searchParams.get('status');
    if (statusValue && !STATUSES.has(statusValue)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_APPROVAL_STATUS' },
        { status: 400 },
      );
    }
    const limitValue = Number(url.searchParams.get('limit') ?? '50');
    const data = await listMoAgentToolApprovals({
      projectId: project_id,
      ...(url.searchParams.get('runId')
        ? { runId: url.searchParams.get('runId')! }
        : {}),
      ...(statusValue
        ? {
            status: statusValue as
              | 'pending'
              | 'approved'
              | 'edited'
              | 'rejected'
              | 'expired',
          }
        : {}),
      limit: Number.isSafeInteger(limitValue) ? limitValue : 50,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof MoAgentToolApprovalStoreError) {
      return NextResponse.json(
        { success: false, error: error.code },
        { status: error.code === 'APPROVAL_NOT_FOUND' ? 404 : 409 },
      );
    }
    console.error('[API] Failed to list MoAgent approvals:', error);
    return NextResponse.json(
      { success: false, error: 'FAILED_TO_LIST_APPROVALS' },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
