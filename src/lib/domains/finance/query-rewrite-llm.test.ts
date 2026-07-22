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
        timeRange: { label: '去年下半年', value: null, unit: 'date_range', evidence: '去年下半年' },
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
    expect(request.tools?.[0]?.inputSchema.required).toEqual(expect.arrayContaining([
      'answerOnlyEvidence',
      'broadUniverseEvidence',
    ]));
    expect(request.temperature).toBe(0);
    expect(request.reasoning).toEqual({ enabled: false });
    expect(request.messages[1].content).not.toContain('deterministic');
    expect(request.messages[1].content).toContain('answerOnlyEvidence');
    expect(request.messages[1].content).toContain('broadUniverseEvidence');
    expect(request.messages[1].content).toContain('multiple unnamed securities');
    expect(request.messages[1].content).toContain('帮我推荐6月3日要买的股票');
    expect(request.messages[1].content).toContain('有哪些股票值得关注');
  });

  it('normalizes local-model null sentinels without weakening other schema checks', async () => {
    const provider: MoAgentModelProvider = {
      name: 'fake-provider',
      async *complete() {
        yield {
          type: 'tool_call_delta',
          index: 0,
          nameDelta: 'emit_query_rewrite_semantics',
          argumentsDelta: JSON.stringify({
            targetCandidates: ['北方稀土', '宁德时代'],
            timeRange: { label: '去年下半年', value: null, unit: 'date_range', evidence: '去年下半年' },
            analysisFocusId: 'comparison',
            outputIntent: 'dashboard',
            answerOnlyEvidence: 'None',
            broadUniverse: false,
            broadUniverseEvidence: 'null',
            confidence: 0.9,
          }),
        };
        yield { type: 'finish', reason: 'tool_calls' };
      },
    };

    await expect(rewriteQuantQuerySemanticsWithProvider({
      input: input(),
      provider,
    })).resolves.toMatchObject({
      ok: true,
      data: {
        timeRange: { label: '去年下半年', unit: 'date_range' },
        answerOnlyEvidence: null,
        broadUniverseEvidence: null,
      },
    });
  });

  it('normalizes empty optional evidence emitted by a local model to JSON null', async () => {
    const provider: MoAgentModelProvider = {
      name: 'fake-provider',
      async *complete() {
        yield {
          type: 'tool_call_delta',
          index: 0,
          nameDelta: 'emit_query_rewrite_semantics',
          argumentsDelta: JSON.stringify({
            targetCandidates: ['大为科技'],
            timeRange: { label: '最近一个季度', value: 1, unit: 'quarter', evidence: '最近一个季度' },
            analysisFocusId: 'events',
            outputIntent: 'answer',
            answerOnlyEvidence: '不做可视化',
            broadUniverse: false,
            broadUniverseEvidence: '',
            confidence: 0.95,
          }),
        };
        yield { type: 'finish', reason: 'tool_calls' };
      },
    };

    await expect(rewriteQuantQuerySemanticsWithProvider({
      input: input(),
      provider,
    })).resolves.toMatchObject({
      ok: true,
      data: { broadUniverseEvidence: null },
    });
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
      repairInstruction: expect.stringContaining('schema'),
    });
  });

  it('adds bounded schema feedback to a repair attempt without replaying invalid payloads', async () => {
    const complete = vi.fn(async function* (_request: MoAgentModelRequest) {
      yield {
        type: 'tool_call_delta' as const,
        index: 0,
        nameDelta: 'emit_query_rewrite_semantics',
        argumentsDelta: JSON.stringify({
          targetCandidates: ['北方稀土'],
          timeRange: null,
          analysisFocusId: 'technical',
          outputIntent: 'dashboard',
          answerOnlyEvidence: null,
          broadUniverse: false,
          broadUniverseEvidence: null,
          confidence: 0.9,
        }),
      };
      yield { type: 'finish' as const, reason: 'tool_calls' as const };
    });
    const provider: MoAgentModelProvider = { name: 'fake-provider', complete };

    await expect(rewriteQuantQuerySemanticsWithProvider({
      input: input(),
      provider,
      repairInstruction: 'The previous object failed at timeRange.value:invalid_type.',
    })).resolves.toMatchObject({ ok: true });

    const request = complete.mock.calls[0][0];
    expect(request.messages[0].content).toContain('Schema repair for this retry');
    expect(request.messages[0].content).toContain('timeRange.value:invalid_type');
  });
});
