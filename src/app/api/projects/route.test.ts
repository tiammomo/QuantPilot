import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  createProject: vi.fn(),
  getAllProjects: vi.fn(),
  reserveQuota: vi.fn(),
  settleQuotaReservation: vi.fn(),
  releaseQuotaReservation: vi.fn(),
  quotaErrorResponse: vi.fn(),
  writeAuthAuditEvent: vi.fn(),
  quotaExceeded: new Error('quota exceeded'),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/project', () => ({
  createProject: mocks.createProject,
  getAllProjects: mocks.getAllProjects,
}));
vi.mock('@/lib/serializers/project', () => ({
  serializeProject: (project: unknown) => project,
  serializeProjects: (projects: unknown) => projects,
}));
vi.mock('@/lib/domains/finance/capabilities', () => ({
  getQuantCapability: () => ({ id: 'stock-research' }),
}));
vi.mock('@/lib/auth/audit', () => ({
  writeAuthAuditEvent: mocks.writeAuthAuditEvent,
}));
vi.mock('@/lib/quota', () => ({
  reserveQuota: mocks.reserveQuota,
  settleQuotaReservation: mocks.settleQuotaReservation,
  releaseQuotaReservation: mocks.releaseQuotaReservation,
  quotaErrorResponse: mocks.quotaErrorResponse,
}));

import { POST } from './route';

function request(
  projectId = 'project-new',
  extra: Record<string, unknown> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'create-test' },
    body: JSON.stringify({ projectId, name: 'New project', ...extra }),
  });
}

describe('POST /api/projects quota orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.requireAction.mockResolvedValue({
      session: { user: { id: 'member-1', role: 'member' } },
    });
    mocks.reserveQuota.mockResolvedValue({
      reservation: { id: 'reservation-1', status: 'active', idempotent: false },
    });
    mocks.createProject.mockResolvedValue({
      id: 'project-new',
      name: 'New project',
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
    });
    mocks.settleQuotaReservation.mockResolvedValue({ eventId: 'usage-1' });
    mocks.releaseQuotaReservation.mockResolvedValue({ status: 'released' });
    mocks.quotaErrorResponse.mockReturnValue(null);
  });

  it('reserves projects.owned after permission succeeds and settles against the created project', async () => {
    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'project.create',
    });
    expect(mocks.reserveQuota).toHaveBeenCalledWith({
      actorUserId: 'member-1',
      metric: 'projects.owned',
      quantity: 1,
      idempotencyKey: 'project-create:member-1:create-test',
      reservationTtlSeconds: 3_600,
    });
    expect(mocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'project-new', name: 'New project' }),
      { ownerId: 'member-1' },
    );
    expect(mocks.settleQuotaReservation).toHaveBeenCalledWith({
      reservationId: 'reservation-1',
      actualQuantity: 1,
      sourceType: 'project',
      sourceId: 'project-new',
      usageEventIdempotencyKey: `project:project-new:${new Date('2026-07-16T00:00:00.000Z').getTime()}:owned`,
    });
    expect(mocks.requireAction.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.reserveQuota.mock.invocationCallOrder[0]);
    expect(mocks.reserveQuota.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createProject.mock.invocationCallOrder[0]);
    expect(mocks.createProject.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.settleQuotaReservation.mock.invocationCallOrder[0]);
    expect(mocks.releaseQuotaReservation).not.toHaveBeenCalled();
  });

  it('preserves a registered local model selection in the service input', async () => {
    const response = await POST(request('project-local', {
      selectedModel: 'local_qwen:qwen3.5-9b-q5km',
    }));

    expect(response.status).toBe(201);
    expect(mocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'project-local',
        selectedModel: 'local_qwen:qwen3.5-9b-q5km',
      }),
      { ownerId: 'member-1' },
    );
  });

  it('rejects legacy aliases before reserving quota', async () => {
    const response = await POST(new NextRequest('http://localhost/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'legacy-project', name: 'Legacy project' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'INVALID_PROJECT_REQUEST',
    });
    expect(mocks.reserveQuota).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('releases the reservation when project creation fails', async () => {
    mocks.createProject.mockRejectedValueOnce(new Error('database write failed'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.releaseQuotaReservation).toHaveBeenCalledWith({
      reservationId: 'reservation-1',
    });
    expect(mocks.settleQuotaReservation).not.toHaveBeenCalled();
  });

  it('returns the quota 429 without creating a project when reservation is denied', async () => {
    mocks.reserveQuota.mockRejectedValueOnce(mocks.quotaExceeded);
    mocks.quotaErrorResponse.mockImplementationOnce((error: unknown) => {
      if (error !== mocks.quotaExceeded) return null;
      return Response.json(
        {
          success: false,
          error: 'QUOTA_EXCEEDED',
          quota: { metric: 'projects.owned', remaining: '0' },
        },
        { status: 429, headers: { 'Retry-After': '3600' } },
      );
    });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'QUOTA_EXCEEDED',
      quota: { metric: 'projects.owned', remaining: '0' },
    });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.settleQuotaReservation).not.toHaveBeenCalled();
    expect(mocks.releaseQuotaReservation).not.toHaveBeenCalled();
  });
});
