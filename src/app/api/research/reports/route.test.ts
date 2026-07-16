import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  getDashboard: vi.fn(),
  runReport: vi.fn(),
  sendReport: vi.fn(),
  claimApiOperation: vi.fn(),
  completeApiOperation: vi.fn(),
  failApiOperation: vi.fn(),
  markApiOperationQuotaAccounted: vi.fn(),
  reserveQuota: vi.fn(),
  settleQuotaReservation: vi.fn(),
  releaseQuotaReservation: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/quant/research-reports', () => ({
  getResearchAutomationDashboard: mocks.getDashboard,
  runDailyResearchReport: mocks.runReport,
  sendResearchReport: mocks.sendReport,
}));
vi.mock('@/lib/server/api-idempotency', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/server/api-idempotency')>(),
  claimApiOperation: mocks.claimApiOperation,
  completeApiOperation: mocks.completeApiOperation,
  failApiOperation: mocks.failApiOperation,
  markApiOperationQuotaAccounted: mocks.markApiOperationQuotaAccounted,
}));
vi.mock('@/lib/quota', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/quota')>(),
  reserveQuota: mocks.reserveQuota,
  settleQuotaReservation: mocks.settleQuotaReservation,
  releaseQuotaReservation: mocks.releaseQuotaReservation,
}));

import { ApiIdempotencyConflictError } from '@/lib/server/api-idempotency';
import { GET, POST } from './route';

function request(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/research/reports', {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json', host: 'localhost' },
          body: JSON.stringify(body),
        }),
  });
}

describe('/api/research/reports authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({});
    mocks.getDashboard.mockResolvedValue({ reports: [] });
    mocks.runReport.mockResolvedValue({ reports: [] });
    mocks.sendReport.mockResolvedValue({ reports: [] });
    mocks.claimApiOperation.mockResolvedValue({
      state: 'acquired',
      handle: { id: 'operation-1', attempt: 1, payloadHash: 'payload-hash' },
    });
    mocks.completeApiOperation.mockResolvedValue({ responseAvailable: true, responseBytes: 100 });
    mocks.failApiOperation.mockResolvedValue(true);
    mocks.markApiOperationQuotaAccounted.mockResolvedValue(true);
    mocks.reserveQuota.mockResolvedValue({ reservation: { id: 'reservation-1' } });
    mocks.settleQuotaReservation.mockResolvedValue({ eventId: 'usage-1' });
    mocks.releaseQuotaReservation.mockResolvedValue({ status: 'released' });
  });

  it('requires report read for the dashboard', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'research.report.read',
    });
  });

  it('requires report run for daily report generation', async () => {
    const response = await POST(request({ action: 'run-daily-report', dryRun: true }));
    expect(response.status).toBe(201);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'research.report.run',
    });
  });

  it('requires the separately delegable send capability', async () => {
    const response = await POST(request({ action: 'send-latest-report', dryRun: true }));
    expect(response.status).toBe(201);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'research.report.send',
    });
  });

  it('replays a completed report run without generating or charging twice', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.claimApiOperation
      .mockResolvedValueOnce({
        state: 'acquired',
        handle: { id: 'operation-1', attempt: 1, payloadHash: 'payload-hash' },
      })
      .mockResolvedValueOnce({
        state: 'completed',
        handle: { id: 'operation-1', attempt: 1, payloadHash: 'payload-hash' },
        responseStatus: 201,
        responseBody: { success: true, data: { reports: [{ id: 'report-1' }] } },
        responseAvailable: true,
      });
    mocks.runReport.mockResolvedValue({ reports: [{ id: 'report-1' }] });

    const first = await POST(request({ action: 'run-daily-report', dryRun: true, idempotencyKey: 'run-1' }));
    const replay = await POST(request({ action: 'run-daily-report', dryRun: true, idempotencyKey: 'run-1' }));

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(mocks.runReport).toHaveBeenCalledTimes(1);
    expect(mocks.reserveQuota).toHaveBeenCalledTimes(1);
    expect(mocks.settleQuotaReservation).toHaveBeenCalledTimes(1);
  });

  it('rejects payload drift before report generation', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.claimApiOperation.mockRejectedValueOnce(new ApiIdempotencyConflictError());

    const response = await POST(request({
      action: 'run-daily-report',
      watchlistId: 'another-watchlist',
      idempotencyKey: 'run-1',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'IDEMPOTENCY_PAYLOAD_CONFLICT' });
    expect(mocks.runReport).not.toHaveBeenCalled();
    expect(mocks.reserveQuota).not.toHaveBeenCalled();
  });

  it('releases a failed report run and fences the retry with a new quota attempt', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.claimApiOperation
      .mockResolvedValueOnce({
        state: 'acquired',
        handle: { id: 'operation-1', attempt: 1, payloadHash: 'payload-hash' },
      })
      .mockResolvedValueOnce({
        state: 'acquired',
        handle: { id: 'operation-1', attempt: 2, payloadHash: 'payload-hash' },
      });
    mocks.reserveQuota
      .mockResolvedValueOnce({ reservation: { id: 'reservation-1' } })
      .mockResolvedValueOnce({ reservation: { id: 'reservation-2' } });
    mocks.runReport
      .mockRejectedValueOnce(new Error('research source unavailable'))
      .mockResolvedValueOnce({ reports: [{ id: 'report-1' }] });

    const failed = await POST(request({ action: 'run-daily-report', idempotencyKey: 'run-retry' }));
    const retried = await POST(request({ action: 'run-daily-report', idempotencyKey: 'run-retry' }));

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(mocks.releaseQuotaReservation).toHaveBeenCalledWith({ reservationId: 'reservation-1' });
    expect(mocks.reserveQuota.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      'research:member-1:run-daily-report:raw:run-retry:attempt:1',
      'research:member-1:run-daily-report:raw:run-retry:attempt:2',
    ]);
  });

  it('scopes the real-delivery fence by actor and persists the quota repair plan', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });

    const response = await POST(request({
      action: 'send-latest-report',
      reportId: 'report-1',
      dryRun: false,
      confirmed: true,
      idempotencyKey: 'send-1',
    }));

    expect(response.status).toBe(201);
    expect(mocks.sendReport).toHaveBeenCalledWith({
      reportId: 'report-1',
      dryRun: false,
      idempotencyKey: 'member-1:raw:send-1',
    });
    expect(mocks.completeApiOperation).toHaveBeenCalledWith(expect.objectContaining({
      quotaSettlement: expect.objectContaining({
        reservationId: 'reservation-1',
        metric: 'research.report_sends.daily',
        usageEventIdempotencyKey: 'research:member-1:send-latest-report:raw:send-1:attempt:1:usage',
      }),
    }));
    expect(mocks.markApiOperationQuotaAccounted).toHaveBeenCalledWith({
      handle: expect.objectContaining({ attempt: 1 }),
      reservationId: 'reservation-1',
    });
  });
});
