import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  writeAuthAuditEvent: vi.fn(),
  getMemoryIntegrationConfig: vi.fn(),
  getPersonalMemoryControl: vi.fn(),
  getPersonalMemoryValueSummary: vi.fn(),
  inspectPersonalMemory: vi.fn(),
  listPersonalPreferences: vi.fn(),
  setPersonalMemoryEnabled: vi.fn(),
}));

vi.mock('@/lib/auth/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/authorization')>();
  return { ...actual, requireAuthSession: mocks.requireAuthSession };
});
vi.mock('@/lib/auth/audit', () => ({ writeAuthAuditEvent: mocks.writeAuthAuditEvent }));
vi.mock('@/lib/platform/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/memory')>();
  return {
    ...actual,
    getMemoryIntegrationConfig: mocks.getMemoryIntegrationConfig,
    getPersonalMemoryControl: mocks.getPersonalMemoryControl,
    getPersonalMemoryValueSummary: mocks.getPersonalMemoryValueSummary,
    inspectPersonalMemory: mocks.inspectPersonalMemory,
    listPersonalPreferences: mocks.listPersonalPreferences,
    setPersonalMemoryEnabled: mocks.setPersonalMemoryEnabled,
  };
});

import { GET, PUT } from './route';

const control = {
  configured: true,
  personalizationEnabled: false,
  policyVersion: 'quantpilot-personalization-v1',
  enabledAt: null,
  disabledAt: new Date('2026-07-18T00:00:00Z'),
  updatedAt: new Date('2026-07-18T00:00:00Z'),
};

describe('/api/account/memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthSession.mockResolvedValue({
      user: { id: 'user-a' },
      session: { id: 'session-a' },
    });
    mocks.getMemoryIntegrationConfig.mockReturnValue({
      enabled: true,
      required: false,
      requireProductionReady: false,
    });
    mocks.getPersonalMemoryControl.mockResolvedValue(control);
    mocks.getPersonalMemoryValueSummary.mockResolvedValue({
      exposedRunCount: 2,
      exposedRevisionReferenceCount: 3,
      legacyEmptyAttributionCount: 1,
      lastExposedAt: new Date('2026-07-18T02:00:00Z'),
      completedFeedbackCount: 2,
      helpfulFeedbackCount: 1,
      rejectedFeedbackCount: 1,
      pendingFeedbackCount: 0,
      failedFeedbackCount: 0,
    });
    mocks.inspectPersonalMemory.mockResolvedValue({
      name: 'Memory',
      version: '0.1.0',
      apiContract: 'evolvable-memory-http/v1',
      capabilities: [],
      authMode: 'development',
      scopeSource: 'request',
      productionReady: false,
      productionBlockers: ['privacy.suppression-erasure'],
    });
    mocks.listPersonalPreferences.mockResolvedValue([]);
    mocks.setPersonalMemoryEnabled.mockResolvedValue({
      ...control,
      personalizationEnabled: true,
      enabledAt: new Date('2026-07-18T01:00:00Z'),
      disabledAt: null,
      updatedAt: new Date('2026-07-18T01:00:00Z'),
      changed: true,
    });
  });

  it('uses only the authenticated subject and never caches memory details', async () => {
    const request = new NextRequest('http://localhost/api/account/memory?subjectId=other');
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.getPersonalMemoryControl).toHaveBeenCalledWith('user-a');
    expect(mocks.getPersonalMemoryValueSummary).toHaveBeenCalledWith('user-a');
    expect(mocks.listPersonalPreferences).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'user-a',
    }));
  });

  it('persists and audits an explicit enable action', async () => {
    const request = new NextRequest('http://localhost/api/account/memory', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personalizationEnabled: true }),
    });
    const response = await PUT(request);

    expect(response.status).toBe(200);
    expect(mocks.setPersonalMemoryEnabled).toHaveBeenCalledWith('user-a', true);
    expect(mocks.writeAuthAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'user-a',
      eventType: 'personal_memory.enabled',
      outcome: 'success',
    }));
  });
});
