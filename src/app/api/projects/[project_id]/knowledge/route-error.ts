import { NextResponse } from 'next/server';

import {
  GovernedKnowledgeFeedbackConflictError,
  GovernedKnowledgeGrowthInputError,
  GovernedKnowledgeGrowthUnavailableError,
  GovernedKnowledgeUseNotFoundError,
} from '@/lib/platform/knowledge';

export function knowledgeRouteError(error: unknown): NextResponse {
  if (error instanceof GovernedKnowledgeUseNotFoundError) {
    return NextResponse.json(
      { success: false, error: 'KNOWLEDGE_USE_NOT_FOUND' },
      { status: 404 },
    );
  }
  if (error instanceof GovernedKnowledgeFeedbackConflictError) {
    return NextResponse.json(
      { success: false, error: 'KNOWLEDGE_FEEDBACK_CONFLICT' },
      { status: 409 },
    );
  }
  if (error instanceof GovernedKnowledgeGrowthInputError) {
    return NextResponse.json(
      { success: false, error: 'INVALID_KNOWLEDGE_FEEDBACK' },
      { status: 400 },
    );
  }
  if (error instanceof GovernedKnowledgeGrowthUnavailableError) {
    return NextResponse.json(
      { success: false, error: error.code },
      { status: 503 },
    );
  }
  console.error('[GovernedKnowledge] API failure.', error);
  return NextResponse.json(
    { success: false, error: 'KNOWLEDGE_FEEDBACK_FAILED' },
    { status: 500 },
  );
}
