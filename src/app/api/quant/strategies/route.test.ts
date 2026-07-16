import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  getStrategyDashboardData: vi.fn(),
  getStrategySymbolBars: vi.fn(),
  enqueueStrategyParameterScan: vi.fn(),
  addStrategyUniverseMember: vi.fn(),
  claimApiOperation: vi.fn(),
  completeApiOperation: vi.fn(),
  failApiOperation: vi.fn(),
  markApiOperationQuotaAccounted: vi.fn(),
  reserveQuota: vi.fn(),
  settleQuotaReservation: vi.fn(),
  releaseQuotaReservation: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/quant/strategies', () => ({
  addStrategyUniverseMember: mocks.addStrategyUniverseMember,
  buildStrategyPrompt: vi.fn(() => ({ prompt: 'strategy' })),
  controlStrategyIngestionJob: vi.fn(),
  enqueueStrategyParameterScan: mocks.enqueueStrategyParameterScan,
  getStrategyDashboardData: mocks.getStrategyDashboardData,
  getStrategyIngestionJobs: vi.fn(),
  getStrategyIntradayBars: vi.fn(),
  getStrategyRealtimeQuote: vi.fn(),
  getStrategySectorCapitalFlow: vi.fn(),
  getStrategySymbolBars: mocks.getStrategySymbolBars,
  getStrategySymbolDividends: vi.fn(),
  getStrategyUniverseMembersPage: vi.fn(),
  ingestStrategyUniverseHistoryBatch: vi.fn(),
  runStrategyScreener: vi.fn(),
  runStrategyDataQualityScan: vi.fn(),
  runStrategyParameterScan: vi.fn(),
  startStrategyUniverseHistoryAutoFill: vi.fn(),
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

function request(
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  idempotencyKey?: string,
): NextRequest {
  return new NextRequest('http://localhost/api/quant/strategies', {
    method,
    ...(body === undefined
      ? { headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined }
      : {
          headers: {
            'content-type': 'application/json',
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
          body: JSON.stringify(body),
        }),
  });
}

describe('/api/quant/strategies authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({});
    mocks.getStrategyDashboardData.mockResolvedValue({});
    mocks.getStrategySymbolBars.mockResolvedValue([]);
    mocks.enqueueStrategyParameterScan.mockResolvedValue({ id: 'scan-1' });
    mocks.addStrategyUniverseMember.mockResolvedValue({ id: 'member-1' });
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

  it('requires data read for the dashboard and data operations', async () => {
    await GET(request());
    expect(mocks.requireAction).toHaveBeenLastCalledWith({
      headers: expect.any(Headers),
      action: 'quant.data.read',
    });

    await POST(request({ action: 'symbol-bars', symbol: '600519' }));
    expect(mocks.requireAction).toHaveBeenLastCalledWith({
      headers: expect.any(Headers),
      action: 'quant.data.read',
    });
  });

  it('distinguishes strategy execution from strategy management', async () => {
    await POST(request({ action: 'run-scan', templateId: 't1', scanId: 's1' }));
    expect(mocks.requireAction).toHaveBeenLastCalledWith({
      headers: expect.any(Headers),
      action: 'quant.strategy.run',
    });

    await POST(request({ action: 'add-universe-member', query: '贵州茅台' }));
    expect(mocks.requireAction).toHaveBeenLastCalledWith({
      headers: expect.any(Headers),
      action: 'quant.strategy.manage',
    });
  });

  it('rejects unknown actions without invoking the authorization repository', async () => {
    const response = await POST(request({ action: 'unknown-action' }));
    expect(response.status).toBe(400);
    expect(mocks.requireAction).not.toHaveBeenCalled();
  });

  it('replays a completed explicit key without repeating data access or quota usage', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.claimApiOperation
      .mockResolvedValueOnce({
        state: 'acquired',
        handle: { id: 'operation-1', attempt: 1, payloadHash: 'payload-hash' },
      })
      .mockResolvedValueOnce({
        state: 'completed',
        handle: { id: 'operation-1', attempt: 1, payloadHash: 'payload-hash' },
        responseStatus: 200,
        responseBody: { success: true, data: [{ symbol: '600519' }] },
        responseAvailable: true,
      });
    mocks.getStrategySymbolBars.mockResolvedValue([{ symbol: '600519' }]);

    const first = await POST(request({ action: 'symbol-bars', symbol: '600519' }, 'POST', 'bars-1'));
    const replay = await POST(request({ action: 'symbol-bars', symbol: '600519' }, 'POST', 'bars-1'));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(mocks.getStrategySymbolBars).toHaveBeenCalledTimes(1);
    expect(mocks.reserveQuota).toHaveBeenCalledTimes(1);
    expect(mocks.settleQuotaReservation).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when an explicit key is reused with another payload', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.claimApiOperation.mockRejectedValueOnce(new ApiIdempotencyConflictError());

    const response = await POST(request({ action: 'symbol-bars', symbol: '000001' }, 'POST', 'bars-1'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'IDEMPOTENCY_PAYLOAD_CONFLICT' });
    expect(mocks.getStrategySymbolBars).not.toHaveBeenCalled();
    expect(mocks.reserveQuota).not.toHaveBeenCalled();
  });

  it('releases failed business usage and uses a new quota key on retry attempt', async () => {
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
    mocks.getStrategySymbolBars
      .mockRejectedValueOnce(new Error('market backend unavailable'))
      .mockResolvedValueOnce([{ symbol: '600519' }]);

    const failed = await POST(request({ action: 'symbol-bars', symbol: '600519' }, 'POST', 'bars-retry'));
    const retried = await POST(request({ action: 'symbol-bars', symbol: '600519' }, 'POST', 'bars-retry'));

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(mocks.releaseQuotaReservation).toHaveBeenCalledWith({ reservationId: 'reservation-1' });
    expect(mocks.failApiOperation).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ attempt: 1 }),
    }));
    expect(mocks.reserveQuota.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      'strategy:member-1:symbol-bars:raw:bars-retry:attempt:1',
      'strategy:member-1:symbol-bars:raw:bars-retry:attempt:2',
    ]);
  });
});
