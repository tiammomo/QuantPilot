import { describe, expect, it, vi } from 'vitest';
import type { MoAgentModelProvider, MoAgentModelRequest } from '@/lib/agent/types';
import type { QuantQuerySemanticRewriteInput } from './query-rewrite';
import { rewriteQuantQuerySemanticsWithProvider } from './query-rewrite-llm';

function input(): QuantQuerySemanticRewriteInput {
  return {
    originalQuery: '比较北方稀土和宁德时代去年下半年走势',
    normalizedQuery: '比较北方稀土和宁德时代去年下半年走势',
    trigger: 'primary',
    requestedModel: 'deepseek-v4-flash',
    signal: new AbortController().signal,
  };
}

describe('query rewrite LLM adapter', () => {
  it('requires a schema-bound tool call and returns validated semantics', async () => {
    const complete = vi.fn(async function* (_request: MoAgentModelRequest) {
      const payload = JSON.stringify({
        targetCandidates: ['北方稀土', '宁德时代'],
        timeRange: { label: '去年下半年', unit: 'date_range', evidence: '去年下半年' },
        analysisFocusId: 'comparison',
        outputIntent: 'dashboard',
        answerOnlyEvidence: null,
        broadUniverse: false,
        broadUniverseEvidence: null,
        confidence: 0.92,
      });
      yield {
        type: 'tool_call_delta' as const,
        index: 0,
        id: 'rewrite-1',
        nameDelta: 'emit_query_rewrite_semantics',
        argumentsDelta: payload.slice(0, 60),
      };
      yield {
        type: 'tool_call_delta' as const,
        index: 0,
        argumentsDelta: payload.slice(60),
      };
      yield {
        type: 'usage' as const,
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      };
      yield { type: 'finish' as const, reason: 'tool_calls' as const };
    });
    const provider: MoAgentModelProvider = { name: 'fake-provider', complete };

    const result = await rewriteQuantQuerySemanticsWithProvider({
      input: input(),
      provider,
    });

    expect(result).toMatchObject({
      ok: true,
      provider: 'fake-provider',
      model: 'deepseek-v4-flash',
      data: {
        targetCandidates: ['北方稀土', '宁德时代'],
        analysisFocusId: 'comparison',
        confidence: 0.92,
      },
      usage: { totalTokens: 130 },
    });
    const request = complete.mock.calls[0][0];
    expect(request.toolChoice).toEqual({ name: 'emit_query_rewrite_semantics' });
    expect(request.tools?.[0]?.inputSchema).toMatchObject({
      properties: {
        answerOnlyEvidence: expect.any(Object),
        broadUniverseEvidence: expect.any(Object),
      },
    });
    expect(request.tools?.[0]?.inputSchema.required).not.toContain('answerOnlyEvidence');
    expect(request.temperature).toBe(0);
    expect(request.reasoning).toEqual({ enabled: false });
    expect(request.messages[1].content).not.toContain('deterministic');
    expect(request.messages[1].content).toContain('answerOnlyEvidence');
    expect(request.messages[1].content).toContain('broadUniverseEvidence');
  });

  it('rejects malformed or out-of-schema tool arguments', async () => {
    const provider: MoAgentModelProvider = {
      name: 'fake-provider',
      async *complete() {
        yield {
          type: 'tool_call_delta',
          index: 0,
          nameDelta: 'emit_query_rewrite_semantics',
          argumentsDelta: JSON.stringify({ targetCandidates: ['北方稀土'] }),
        };
        yield { type: 'finish', reason: 'tool_calls' };
      },
    };

    await expect(rewriteQuantQuerySemanticsWithProvider({
      input: input(),
      provider,
    })).resolves.toMatchObject({
      ok: false,
      code: 'LLM_INVALID_OUTPUT',
      retryable: false,
    });
  });
});
