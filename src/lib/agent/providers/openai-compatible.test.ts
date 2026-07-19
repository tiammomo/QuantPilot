import { describe, expect, it, vi } from 'vitest';
import type { MoAgentModelEvent } from '../types';
import {
  OpenAICompatibleProvider,
  OpenAICompatibleProviderError,
} from './openai-compatible';

async function collect(iterable: AsyncIterable<MoAgentModelEvent>) {
  const events: MoAgentModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('OpenAICompatibleProvider', () => {
  it('uses the standard chat-completions wire format without DeepSeek thinking fields', async () => {
    const payload = [
      {
        id: 'local-response-1',
        model: 'local_qwen:qwen3.5-9b-q5km',
        choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
      },
      {
        id: 'local-response-1',
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fetchMock = vi.fn(async () => new Response(payload, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      apiKey: 'local-secret',
      baseUrl: 'http://127.0.0.1:38082/v1',
      fetchImpl,
    });

    const events = await collect(provider.complete({
      model: 'local_qwen:qwen3.5-9b-q5km',
      messages: [
        { role: 'user', content: 'probe' },
        { role: 'assistant', content: '', reasoningContent: 'private reasoning' },
      ],
      reasoning: { enabled: true, effort: 'high' },
    }));

    expect(provider.name).toBe('openai');
    expect(events).toContainEqual({ type: 'text_delta', delta: 'OK' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:38082/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.messages[1]).not.toHaveProperty('reasoning_content');
  });

  it('merges consecutive leading system messages for strict local Qwen templates', async () => {
    const payload = [
      {
        id: 'local-response-system-prefix',
        model: 'local_qwen:qwen3.5-9b-q5km',
        choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
      },
      {
        id: 'local-response-system-prefix',
        choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fetchMock = vi.fn(async () => new Response(payload, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const provider = new OpenAICompatibleProvider({
      apiKey: 'local-secret',
      baseUrl: 'http://127.0.0.1:38082/v1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const messages = [
      { role: 'system' as const, content: 'Kernel policy' },
      { role: 'system' as const, content: 'Trusted context protocol' },
      { role: 'user' as const, content: 'probe' },
    ];

    await collect(provider.complete({
      model: 'local_qwen:qwen3.5-9b-q5km',
      messages,
    }));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([
      { role: 'system', content: 'Kernel policy\n\nTrusted context protocol' },
      { role: 'user', content: 'probe' },
    ]);
    expect(messages).toEqual([
      { role: 'system', content: 'Kernel policy' },
      { role: 'system', content: 'Trusted context protocol' },
      { role: 'user', content: 'probe' },
    ]);
  });

  it('wraps hardened transport failures with a provider-neutral error', async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'local-secret',
      baseUrl: 'http://127.0.0.1:38082/v1',
      maxRetries: 0,
      fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    });

    await expect(collect(provider.complete({
      model: 'local_qwen:qwen3.5-9b-q5km',
      messages: [{ role: 'user', content: 'probe' }],
    }))).rejects.toMatchObject({
      name: 'OpenAICompatibleProviderError',
      code: 'HTTP_ERROR',
      status: 401,
    } satisfies Partial<OpenAICompatibleProviderError>);
  });

  it('derives cache misses from standard OpenAI prompt token details', async () => {
    const payload = [
      {
        id: 'local-response-usage',
        model: 'local_qwen:qwen3.5-9b-q5km',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'local-response-usage',
        choices: [],
        usage: {
          prompt_tokens: 293,
          completion_tokens: 90,
          total_tokens: 383,
          prompt_tokens_details: { cached_tokens: 289 },
        },
      },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const provider = new OpenAICompatibleProvider({
      apiKey: 'local-secret',
      baseUrl: 'http://127.0.0.1:38082/v1',
      fetchImpl: (async () => new Response(payload, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch,
    });

    const events = await collect(provider.complete({
      model: 'local_qwen:qwen3.5-9b-q5km',
      messages: [{ role: 'user', content: 'probe' }],
    }));

    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 293,
        outputTokens: 90,
        totalTokens: 383,
        cachedInputTokens: 289,
        cacheMissInputTokens: 4,
      },
    });
  });
});
