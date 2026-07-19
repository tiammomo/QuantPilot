import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  claimApiOperation: vi.fn(),
  completeApiOperation: vi.fn(),
  failApiOperation: vi.fn(),
  markApiOperationQuotaAccounted: vi.fn(),
  reserveQuota: vi.fn(),
  settleQuotaReservation: vi.fn(),
  releaseQuotaReservation: vi.fn(),
  recordQuotaUsage: vi.fn(),
  rewriteQuantQuery: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/quant/query-rewrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/quant/query-rewrite')>();
  mocks.rewriteQuantQuery.mockImplementation(actual.rewriteQuantQuery);
  return { ...actual, rewriteQuantQuery: mocks.rewriteQuantQuery };
});
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
  recordQuotaUsage: mocks.recordQuotaUsage,
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { ApiIdempotencyConflictError } from '@/lib/server/api-idempotency';
import { POST } from './route';

function request(body: unknown, idempotencyKey?: string): NextRequest {
  return new NextRequest('http://localhost/api/quant/query/rewrite', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAction.mockResolvedValue({});
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
  mocks.recordQuotaUsage.mockResolvedValue({ eventId: 'tokens-1' });
});

describe('POST /api/quant/query/rewrite', () => {
  it('returns a versioned executable rewrite contract', async () => {
    mocks.rewriteQuantQuery.mockResolvedValueOnce({
      schemaVersion: 4,
      status: 'ready',
      targetCandidates: ['北方稀土'],
      resolvedSymbols: [{ symbol: '600111', market: 'SH' }],
      issues: [],
      execution: {
        strategy: 'llm_primary',
        llm: {
          attempted: true,
          applied: true,
          status: 'applied',
          provider: 'openai',
          model: 'local_qwen:qwen3.5-9b-q5km',
          usage: null,
        },
      },
      safety: { decision: 'allow' },
    });

    const response = await POST(request({
      query: '帮我分析一下北方稀土',
      purpose: 'execution',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      data: {
        schemaVersion: 4,
        status: 'ready',
        targetCandidates: ['北方稀土'],
        resolvedSymbols: [{ symbol: '600111', market: 'SH' }],
      },
      meta: {
        schemaVersion: 4,
        purpose: 'execution',
        strategy: 'llm_primary',
        llmStatus: 'applied',
      },
    });
    expect(payload.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'quant.query.rewrite.llm',
    });
  });

  it('uses a stable error envelope for invalid input', async () => {
    const response = await POST(request({ query: ' ' }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      success: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'query 长度必须在 2 到 2000 个字符之间。',
        retryable: false,
      },
    });
  });

  it('defaults unspecified calls to LLM execution mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      results: [{
        symbol: '600111',
        name: '北方稀土',
        asset_type: 'stock',
        market: 'SH',
        secid: '1.600111',
      }],
    })));

    const response = await POST(request({ query: '帮我分析一下北方稀土' }));
    const payload = await response.json();

    expect(payload.meta).toMatchObject({
      purpose: 'execution',
      strategy: 'llm_unavailable',
      llmStatus: 'skipped_unconfigured',
    });
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'quant.query.rewrite.llm',
    });
    expect(mocks.rewriteQuantQuery).toHaveBeenCalledWith(
      '帮我分析一下北方稀土',
      expect.objectContaining({}),
    );
  });

  it('keeps preview compatibility without using a model-free rewrite path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ results: [] })));

    const response = await POST(request({
      query: '分析大位科技最近20个交易日',
      purpose: 'preview',
      model: 'local_qwen:qwen3.5-9b-q5km',
    }));
    const payload = await response.json();

    expect(payload.meta).toMatchObject({
      purpose: 'preview',
      strategy: 'llm_unavailable',
      llmStatus: 'skipped_unconfigured',
    });
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'quant.query.rewrite.llm',
    });
    expect(mocks.rewriteQuantQuery).toHaveBeenCalledWith(
      '分析大位科技最近20个交易日',
      expect.objectContaining({
        requestedModel: 'local_qwen:qwen3.5-9b-q5km',
      }),
    );
  });

  it('returns the authorization response before executing a denied rewrite', async () => {
    mocks.requireAction.mockRejectedValueOnce(
      new AuthorizationError('CAPABILITY_DENIED', 403, '能力不足。'),
    );
    const response = await POST(request({ query: '分析贵州茅台', purpose: 'execution' }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'CAPABILITY_DENIED',
    });
  });

  it('returns a policy refusal for guaranteed-return requests', async () => {
    const response = await POST(request({
      query: '明天买哪只股票一定能涨停？',
      purpose: 'execution',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      data: {
        schemaVersion: 4,
        status: 'refused',
        safety: {
          decision: 'refuse',
          code: 'GUARANTEED_RETURN_REQUEST',
        },
      },
      meta: {
        purpose: 'execution',
        safetyDecision: 'refuse',
      },
    });
  });

  it('replays a completed explicit key without executing the rewrite or quota path', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.claimApiOperation.mockResolvedValueOnce({
      state: 'completed',
      handle: { id: 'operation-1', attempt: 1, payloadHash: 'payload-hash' },
      responseStatus: 200,
      responseBody: {
        success: true,
        data: { schemaVersion: 4, status: 'ready' },
        meta: { requestId: 'rewrite-1' },
      },
      responseAvailable: true,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request({
      query: '分析贵州茅台',
      purpose: 'execution',
    }, 'rewrite-1'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.reserveQuota).not.toHaveBeenCalled();
  });

  it('rejects reuse of an explicit key with a different query', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.claimApiOperation.mockRejectedValueOnce(new ApiIdempotencyConflictError());

    const response = await POST(request({
      query: '分析宁德时代',
      purpose: 'execution',
    }, 'rewrite-1'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' },
    });
    expect(mocks.reserveQuota).not.toHaveBeenCalled();
  });

  it('persists a quota repair plan before settlement and leaves it pending on settlement failure', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.settleQuotaReservation.mockRejectedValueOnce(new Error('database temporarily unavailable'));

    const response = await POST(request({
      query: '明天买哪只股票一定能涨停？',
      purpose: 'execution',
    }, 'rewrite-repair'));

    expect(response.status).toBe(200);
    expect(mocks.completeApiOperation).toHaveBeenCalledWith(expect.objectContaining({
      quotaSettlement: expect.objectContaining({
        reservationId: 'reservation-1',
        metric: 'query_rewrite.llm.daily',
        usageEventIdempotencyKey: 'query-rewrite:member-1:raw:rewrite-repair:attempt:1:request',
      }),
    }));
    expect(mocks.markApiOperationQuotaAccounted).not.toHaveBeenCalled();
    expect(mocks.releaseQuotaReservation).not.toHaveBeenCalled();
  });

  it('persists token usage and marks accounting only after both usage writes succeed', async () => {
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'member-1' } } });
    mocks.rewriteQuantQuery.mockResolvedValueOnce({
      schemaVersion: 4,
      status: 'ready',
      execution: {
        strategy: 'llm_primary',
        llm: {
          attempted: true,
          status: 'applied',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          usage: { inputTokens: 200, outputTokens: 121, totalTokens: 321 },
        },
      },
      safety: { decision: 'allow' },
    });
    mocks.recordQuotaUsage.mockRejectedValueOnce(new Error('token usage store unavailable'));

    const response = await POST(request({
      query: '分析贵州茅台的近期趋势',
      purpose: 'execution',
    }, 'rewrite-tokens'));

    expect(response.status).toBe(200);
    expect(mocks.completeApiOperation).toHaveBeenCalledWith(expect.objectContaining({
      quotaSettlement: expect.objectContaining({
        additionalUsage: [expect.objectContaining({
          metric: 'llm.total_tokens.monthly',
          quantity: 321,
          idempotencyKey: 'query-rewrite:member-1:raw:rewrite-tokens:attempt:1:tokens',
        })],
      }),
    }));
    expect(mocks.settleQuotaReservation.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.recordQuotaUsage.mock.invocationCallOrder[0]);
    expect(mocks.markApiOperationQuotaAccounted).not.toHaveBeenCalled();
  });
});
