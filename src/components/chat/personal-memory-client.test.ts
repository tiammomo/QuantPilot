import { describe, expect, it, vi } from 'vitest';

import {
  buildPersonalPreferencePayload,
  loadPersonalMemoryAttribution,
  savePersonalPreference,
  submitPersonalMemoryFeedback,
} from './personal-memory-client';

describe('personal memory browser client', () => {
  it('builds an explicit bounded preference payload without identity or provider fields', () => {
    expect(buildPersonalPreferencePayload({
      eventId: 'event-a',
      key: 'output.answer_style',
      value: ' 先给结论，再给证据 ',
      scope: 'project',
    })).toEqual({
      eventId: 'event-a',
      key: 'output.answer_style',
      value: '先给结论，再给证据',
      evidenceText: '用户通过 QuantPilot“记住偏好”面板明确确认：先给结论，再给证据',
      confidence: 1,
      scope: 'project',
    });
  });

  it('calls only the QuantPilot project API and never sends tenant or subject scope', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));

    await savePersonalPreference({
      projectId: 'project/a',
      eventId: 'event-a',
      key: 'analysis.risk_style',
      value: '明确列出最大回撤风险',
      scope: 'global',
    }, fetcher);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('/api/projects/project%2Fa/memory/preferences');
    const body = JSON.parse(fetcher.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('subjectId');
  });

  it('loads only opaque revision attribution for an actually exposed request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { revisionIds: ['revision-a', 7, 'revision-b'], contentSha256: 'hash' },
    }), { status: 200 }));

    await expect(loadPersonalMemoryAttribution({
      projectId: 'project-a',
      requestId: 'request/a',
    }, fetcher)).resolves.toEqual(['revision-a', 'revision-b']);
    expect(fetcher.mock.calls[0][0]).toBe(
      '/api/projects/project-a/memory/uses/request%2Fa',
    );
  });

  it('submits one stable attributable outcome per exposed revision', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 201,
    }));
    const input = {
      projectId: 'project-a',
      requestId: 'request-a',
      revisionIds: ['revision-a', 'revision-b'],
      kind: 'helpful' as const,
    };

    await submitPersonalMemoryFeedback(input, fetcher);
    const firstBodies = fetcher.mock.calls.map((call) => JSON.parse(call[1].body as string));
    fetcher.mockClear();
    await submitPersonalMemoryFeedback(input, fetcher);
    const replayBodies = fetcher.mock.calls.map((call) => JSON.parse(call[1].body as string));

    expect(firstBodies).toHaveLength(2);
    expect(firstBodies.map((body) => body.revisionId)).toEqual(['revision-a', 'revision-b']);
    expect(replayBodies).toEqual(firstBodies);
  });
});
