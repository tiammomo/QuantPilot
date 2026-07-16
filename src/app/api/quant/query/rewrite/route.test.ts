import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/quant/query/rewrite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/quant/query/rewrite', () => {
  it('returns a versioned executable rewrite contract', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      expect(url.pathname).toBe('/api/v1/symbols/resolve');
      expect(url.searchParams.get('query')).toBe('北方稀土');
      return Response.json({
        results: [{
          symbol: '600111',
          name: '北方稀土',
          asset_type: 'stock',
          market: 'SH',
          secid: '1.600111',
          source: 'eastmoney',
        }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request({
      query: '帮我分析一下北方稀土',
      purpose: 'execution',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      data: {
        schemaVersion: 3,
        status: 'ready',
        targetCandidates: ['北方稀土'],
        resolvedSymbols: [{ symbol: '600111', market: 'SH' }],
      },
      meta: {
        schemaVersion: 3,
        purpose: 'execution',
        strategy: 'deterministic',
        llmStatus: 'not_needed',
      },
    });
    expect(payload.meta.durationMs).toBeGreaterThanOrEqual(0);
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

  it('defaults unspecified calls to deterministic preview mode', async () => {
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
      purpose: 'preview',
      strategy: 'deterministic',
      llmStatus: 'not_requested',
    });
  });

  it('returns a deterministic refusal for guaranteed-return requests', async () => {
    const response = await POST(request({
      query: '明天买哪只股票一定能涨停？',
      purpose: 'execution',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      data: {
        schemaVersion: 3,
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
});
