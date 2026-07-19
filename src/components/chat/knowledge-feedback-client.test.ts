import { describe, expect, it, vi } from 'vitest';

import {
  GovernedKnowledgeFeedbackClientError,
  loadGovernedKnowledgeAttribution,
  submitGovernedKnowledgeFeedback,
} from './knowledge-feedback-client';

const attribution = {
  requestId: 'request-1',
  citationCount: 2,
  revisionCount: 1,
  spaceCount: 1,
  feedbackStatus: 'awaiting_feedback',
  feedbackOutcome: null,
  feedbackAvailable: true,
};

describe('governed knowledge feedback client', () => {
  it('loads request-scoped attribution without caching', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: attribution }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(loadGovernedKnowledgeAttribution({
      projectId: 'project-1',
      requestId: 'request-1',
    }, fetcher)).resolves.toMatchObject({ citationCount: 2, feedbackAvailable: true });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/projects/project-1/knowledge/uses/request-1',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('submits a stable explicit business outcome', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      data: { ...attribution, feedbackStatus: 'completed', feedbackOutcome: 'harmed' },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    await submitGovernedKnowledgeFeedback({
      projectId: 'project-1',
      requestId: 'request-1',
      outcome: 'harmed',
    }, fetcher);
    const init = fetcher.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({
      requestId: 'request-1',
      eventId: 'knowledge-feedback:request-1:harmed',
      outcome: 'harmed',
    });
  });

  it('exposes a typed not-found result so the optional control can hide', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: 'KNOWLEDGE_USE_NOT_FOUND' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(loadGovernedKnowledgeAttribution({
      projectId: 'project-1',
      requestId: 'request-1',
    }, fetcher)).rejects.toMatchObject({
      code: 'KNOWLEDGE_USE_NOT_FOUND',
      status: 404,
    } satisfies Partial<GovernedKnowledgeFeedbackClientError>);
  });
});
