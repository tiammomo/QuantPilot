import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  correctPersonalPreference: vi.fn(),
  writeAuthAuditEvent: vi.fn(),
}));

vi.mock('@/lib/auth/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/authorization')>();
  return { ...actual, requireAuthSession: mocks.requireAuthSession };
});
vi.mock('@/lib/auth/audit', () => ({ writeAuthAuditEvent: mocks.writeAuthAuditEvent }));
vi.mock('@/lib/platform/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/memory')>();
  return { ...actual, correctPersonalPreference: mocks.correctPersonalPreference };
});

import { POST } from './route';

const context = { params: Promise.resolve({ record_id: 'record-a' }) };

describe('/api/account/memory/preferences/:recordId/corrections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthSession.mockResolvedValue({ user: { id: 'user-a' } });
    mocks.correctPersonalPreference.mockResolvedValue({
      revisionId: 'revision-b',
      sequence: 2,
      idempotentReplay: false,
    });
  });

  it('derives subject scope only from the authenticated account and audits the correction', async () => {
    const response = await POST(new NextRequest('http://localhost/api/account/memory/preferences/record-a/corrections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'forged-user',
        eventId: 'correction-a',
        value: '以后先给结论',
        evidenceText: '用户明确修正',
        reason: '原偏好不准确',
        expectedRevisionId: 'revision-a',
      }),
    }), context);

    expect(response.status).toBe(400);
    expect(mocks.correctPersonalPreference).not.toHaveBeenCalled();

    const validResponse = await POST(new NextRequest('http://localhost/api/account/memory/preferences/record-a/corrections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: 'correction-a',
        value: '以后先给结论',
        evidenceText: '用户明确修正',
        reason: '原偏好不准确',
        expectedRevisionId: 'revision-a',
      }),
    }), context);

    expect(validResponse.status).toBe(201);
    expect(validResponse.headers.get('cache-control')).toContain('no-store');
    expect(mocks.correctPersonalPreference).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'user-a',
      recordId: 'record-a',
      expectedRevisionId: 'revision-a',
    }));
    expect(mocks.writeAuthAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'user-a',
      eventType: 'personal_memory.preference_corrected',
    }));
  });
});
