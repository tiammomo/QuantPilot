import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import type { PiAgentToolApprovalDecision } from '@/lib/agent/types';
import {
  PiAgentToolApprovalStoreError,
  resolvePiAgentToolApproval,
} from '@/lib/services/pi-agent-tool-approval-store';

interface RouteContext {
  params: Promise<{ project_id: string; approval_id: string }>;
}

const DECISIONS = new Set<PiAgentToolApprovalDecision>([
  'approve',
  'edit',
  'reject',
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id, approval_id } = await params;
    const actor = await requireAction({
      headers: request.headers,
      action: 'project.update',
      projectId: project_id,
    });
    const body = record(await request.json().catch(() => ({})));
    const decision =
      typeof body.decision === 'string' &&
      DECISIONS.has(body.decision as PiAgentToolApprovalDecision)
        ? body.decision as PiAgentToolApprovalDecision
        : null;
    if (!decision) {
      return NextResponse.json(
        { success: false, error: 'INVALID_APPROVAL_DECISION' },
        { status: 400 },
      );
    }
    const data = await resolvePiAgentToolApproval({
      projectId: project_id,
      approvalId: approval_id,
      actorId: actor.actorUserId,
      ...(!actor.localSystemAdmin
        ? { actorUserId: actor.actorUserId }
        : {}),
      decision,
      ...(body.editedInput !== undefined
        ? { editedInput: body.editedInput }
        : {}),
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof PiAgentToolApprovalStoreError) {
      const status =
        error.code === 'APPROVAL_NOT_FOUND'
          ? 404
          : error.code === 'INVALID_APPROVAL'
            ? 400
            : 409;
      return NextResponse.json(
        { success: false, error: error.code, message: error.message },
        { status },
      );
    }
    console.error('[API] Failed to resolve PI Agent approval:', error);
    return NextResponse.json(
      { success: false, error: 'FAILED_TO_RESOLVE_APPROVAL' },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
