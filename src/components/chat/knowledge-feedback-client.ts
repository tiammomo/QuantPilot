import type { KnowledgeFeedbackOutcome } from '@/lib/platform/knowledge/types';

export interface GovernedKnowledgeAttributionView {
  requestId: string;
  citationCount: number;
  revisionCount: number;
  spaceCount: number;
  feedbackStatus: 'awaiting_feedback' | 'pending' | 'completed' | 'failed';
  feedbackOutcome: KnowledgeFeedbackOutcome | null;
  feedbackAvailable: boolean;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ApiEnvelope {
  success?: boolean;
  error?: string;
  message?: string;
  data?: unknown;
}

export class GovernedKnowledgeFeedbackClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GovernedKnowledgeFeedbackClientError';
  }
}

async function payload(response: Response): Promise<ApiEnvelope> {
  return response.json().catch(() => ({})) as Promise<ApiEnvelope>;
}

function messageFor(data: ApiEnvelope, fallback: string): string {
  if (typeof data.message === 'string' && data.message.trim()) return data.message;
  if (data.error === 'KNOWLEDGE_FEEDBACK_EXPIRED') return '本轮知识反馈窗口已结束。';
  if (data.error === 'KNOWLEDGE_FEEDBACK_CONFLICT') return '本轮知识效果已经记录，不能改成另一种结果。';
  return fallback;
}

function attribution(value: unknown): GovernedKnowledgeAttributionView {
  const data = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    requestId: typeof data.requestId === 'string' ? data.requestId : '',
    citationCount: typeof data.citationCount === 'number' ? data.citationCount : 0,
    revisionCount: typeof data.revisionCount === 'number' ? data.revisionCount : 0,
    spaceCount: typeof data.spaceCount === 'number' ? data.spaceCount : 0,
    feedbackStatus: data.feedbackStatus === 'pending'
      || data.feedbackStatus === 'completed'
      || data.feedbackStatus === 'failed'
      ? data.feedbackStatus
      : 'awaiting_feedback',
    feedbackOutcome: data.feedbackOutcome === 'helped'
      || data.feedbackOutcome === 'neutral'
      || data.feedbackOutcome === 'harmed'
      ? data.feedbackOutcome
      : null,
    feedbackAvailable: data.feedbackAvailable === true,
  };
}

export async function loadGovernedKnowledgeAttribution(input: {
  projectId: string;
  requestId: string;
  signal?: AbortSignal;
}, fetcher: Fetcher = fetch): Promise<GovernedKnowledgeAttributionView> {
  const response = await fetcher(
    `/api/projects/${encodeURIComponent(input.projectId)}/knowledge/uses/${encodeURIComponent(input.requestId)}`,
    { cache: 'no-store', signal: input.signal },
  );
  const data = await payload(response);
  if (!response.ok) {
    throw new GovernedKnowledgeFeedbackClientError(
      messageFor(data, '本轮知识归因暂不可用。'),
      typeof data.error === 'string' ? data.error : 'KNOWLEDGE_USE_FAILED',
      response.status,
    );
  }
  return attribution(data.data);
}

export async function submitGovernedKnowledgeFeedback(input: {
  projectId: string;
  requestId: string;
  outcome: KnowledgeFeedbackOutcome;
}, fetcher: Fetcher = fetch): Promise<GovernedKnowledgeAttributionView> {
  const response = await fetcher(
    `/api/projects/${encodeURIComponent(input.projectId)}/knowledge/outcomes`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: input.requestId,
        eventId: `knowledge-feedback:${input.requestId.slice(0, 160)}:${input.outcome}`,
        outcome: input.outcome,
      }),
    },
  );
  const data = await payload(response);
  if (!response.ok) {
    throw new GovernedKnowledgeFeedbackClientError(
      messageFor(data, '知识效果反馈提交失败，请重试。'),
      typeof data.error === 'string' ? data.error : 'KNOWLEDGE_FEEDBACK_FAILED',
      response.status,
    );
  }
  return attribution(data.data);
}
