import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import {
  recordGovernedKnowledgeBusinessFeedback,
  type KnowledgeFeedbackOutcome,
} from '@/lib/platform/knowledge';

import { knowledgeRouteError } from '../route-error';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const OUTCOMES = new Set<KnowledgeFeedbackOutcome>(['helped', 'neutral', 'harmed']);

function bodyRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const actor = await requireAction({
      headers: request.headers,
      action: 'project.update',
      projectId: project_id,
    });
    const body = bodyRecord(await request.json().catch(() => ({})));
    const outcome = typeof body.outcome === 'string' && OUTCOMES.has(body.outcome as KnowledgeFeedbackOutcome)
      ? body.outcome as KnowledgeFeedbackOutcome
      : null;
    if (!outcome) {
      return NextResponse.json(
        { success: false, error: 'INVALID_KNOWLEDGE_FEEDBACK' },
        { status: 400 },
      );
    }
    const data = await recordGovernedKnowledgeBusinessFeedback({
      projectId: project_id,
      actorUserId: actor.actorUserId,
      requestId: typeof body.requestId === 'string' ? body.requestId : '',
      eventId: typeof body.eventId === 'string' ? body.eventId : '',
      outcome,
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return knowledgeRouteError(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
