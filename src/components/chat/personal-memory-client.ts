import type {
  PersonalMemoryPreferenceKey,
  PersonalMemoryScope,
} from '@/lib/platform/memory/candidate-types';

export const PERSONAL_MEMORY_PREFERENCE_OPTIONS = [
  { key: 'output.answer_style', label: '回答结构' },
  { key: 'output.detail_level', label: '回答详略' },
  { key: 'output.visual_style', label: '图表与呈现' },
  { key: 'analysis.risk_style', label: '风险表达' },
  { key: 'analysis.default_market', label: '默认市场' },
  { key: 'research.default_horizon', label: '研究周期' },
  { key: 'research.evidence_style', label: '证据偏好' },
] as const;

export type { PersonalMemoryPreferenceKey, PersonalMemoryScope };
export type PersonalMemoryFeedbackKind = 'helpful' | 'rejected';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ApiEnvelope {
  success?: boolean;
  error?: string;
  message?: string;
  data?: unknown;
}

export class PersonalMemoryClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PersonalMemoryClientError';
  }
}

async function responsePayload(response: Response): Promise<ApiEnvelope> {
  return response.json().catch(() => ({})) as Promise<ApiEnvelope>;
}

function apiMessage(payload: ApiEnvelope, fallback: string): string {
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  if (payload.error === 'MEMORY_OPTED_OUT') {
    return '请先在“账号 → 用户记忆”中启用个性化。';
  }
  if (payload.error === 'MEMORY_DISABLED') return 'QuantPilot 当前未启用用户记忆。';
  return fallback;
}

export function buildPersonalPreferencePayload(input: {
  eventId: string;
  key: PersonalMemoryPreferenceKey;
  value: string;
  scope: PersonalMemoryScope;
}): Record<string, unknown> {
  const value = input.value.trim();
  return {
    eventId: input.eventId,
    key: input.key,
    value,
    evidenceText: `用户通过 QuantPilot“记住偏好”面板明确确认：${value}`,
    confidence: 1,
    scope: input.scope,
  };
}

export async function savePersonalPreference(input: {
  projectId: string;
  eventId: string;
  key: PersonalMemoryPreferenceKey;
  value: string;
  scope: PersonalMemoryScope;
}, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(
    `/api/projects/${encodeURIComponent(input.projectId)}/memory/preferences`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPersonalPreferencePayload(input)),
    },
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new PersonalMemoryClientError(
      apiMessage(payload, '偏好保存失败，请稍后重试。'),
      typeof payload.error === 'string' ? payload.error : 'MEMORY_WRITE_FAILED',
      response.status,
    );
  }
}

export async function loadPersonalMemoryAttribution(input: {
  projectId: string;
  requestId: string;
  signal?: AbortSignal;
}, fetcher: Fetcher = fetch): Promise<string[]> {
  const response = await fetcher(
    `/api/projects/${encodeURIComponent(input.projectId)}/memory/uses/${encodeURIComponent(input.requestId)}`,
    { cache: 'no-store', signal: input.signal },
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new PersonalMemoryClientError(
      apiMessage(payload, '本轮记忆归因暂不可用。'),
      typeof payload.error === 'string' ? payload.error : 'MEMORY_USE_FAILED',
      response.status,
    );
  }
  const data = payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : {};
  return Array.isArray(data.revisionIds)
    ? data.revisionIds.filter((value): value is string => typeof value === 'string')
    : [];
}

function feedbackEventId(requestId: string, index: number, kind: PersonalMemoryFeedbackKind): string {
  return `memory-feedback:${requestId.slice(0, 96)}:${index}:${kind}`;
}

export async function submitPersonalMemoryFeedback(input: {
  projectId: string;
  requestId: string;
  revisionIds: readonly string[];
  kind: PersonalMemoryFeedbackKind;
}, fetcher: Fetcher = fetch): Promise<void> {
  const outcomes = input.revisionIds.map(async (revisionId, index) => {
    const response = await fetcher(
      `/api/projects/${encodeURIComponent(input.projectId)}/memory/outcomes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: input.requestId,
          revisionId,
          eventId: feedbackEventId(input.requestId, index, input.kind),
          kind: input.kind,
          weight: 1,
        }),
      },
    );
    const payload = await responsePayload(response);
    if (!response.ok) {
      throw new PersonalMemoryClientError(
        apiMessage(payload, '记忆反馈提交失败，请重试。'),
        typeof payload.error === 'string' ? payload.error : 'MEMORY_FEEDBACK_FAILED',
        response.status,
      );
    }
  });
  await Promise.all(outcomes);
}
