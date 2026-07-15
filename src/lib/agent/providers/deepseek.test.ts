import { describe, expect, it, vi } from 'vitest';
import type { MoAgentModelEvent, MoAgentModelRequest } from '../types';
import { DeepSeekProvider, DeepSeekProviderError } from './deepseek';

function sseResponse(chunks: unknown[], options?: { splitEvery?: number }): Response {
  const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  const encoded = new TextEncoder().encode(payload);
  const splitEvery = options?.splitEvery ?? encoded.length;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += splitEvery) {
          controller.enqueue(encoded.slice(offset, offset + splitEvery));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

async function collect(iterable: AsyncIterable<MoAgentModelEvent>): Promise<MoAgentModelEvent[]> {
  const events: MoAgentModelEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function request(overrides: Partial<MoAgentModelRequest> = {}): MoAgentModelRequest {
  return {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Build it' }],
    ...overrides,
  };
}

describe('DeepSeekProvider', () => {
  it('streams text, reasoning, fragmented tool calls, usage, and finish reason', async () => {
    const response = sseResponse(
      [
        {
          id: 'response-1',
          model: 'deepseek-v4-flash',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'inspect ',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    function: { name: 'read_', arguments: '{"pa' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
          usage: null,
        },
        {
          id: 'response-1',
          model: 'deepseek-v4-flash',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'first',
                content: 'Working',
                tool_calls: [
                  { index: 0, function: { name: 'file', arguments: 'th":"app/page.tsx"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
          usage: null,
        },
        {
          id: 'response-1',
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: null,
        },
        {
          id: 'response-1',
          model: 'deepseek-v4-flash',
          choices: [],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
            prompt_cache_hit_tokens: 12,
            prompt_cache_miss_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
      ],
      { splitEvery: 7 }
    );
    const fetchMock = vi.fn(async () => response);
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const provider = new DeepSeekProvider({
      apiKey: 'secret-key',
      baseUrl: 'https://api.deepseek.com/v1/',
      fetchImpl,
      headers: { 'X-Client': 'quantpilot', authorization: 'must-not-win' },
    });

    const events = await collect(
      provider.complete(
        request({
          messages: [
            { role: 'user', content: 'Build it' },
            {
              role: 'assistant',
              content: '',
              reasoningContent: 'must replay',
              toolCalls: [{ id: 'old-call', name: 'read_file', arguments: '{}' }],
            },
            { role: 'tool', toolCallId: 'old-call', content: '{"ok":true}' },
          ],
          tools: [
            {
              name: 'read_file',
              description: 'Read a file',
              inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
            },
          ],
          toolChoice: { name: 'read_file' },
          maxTokens: 123,
          reasoning: { enabled: true, effort: 'max' },
        })
      )
    );

    expect(events).toEqual([
      { type: 'response_start', responseId: 'response-1', model: 'deepseek-v4-flash' },
      { type: 'reasoning_delta', delta: 'inspect ' },
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-1',
        nameDelta: 'read_',
        argumentsDelta: '{"pa',
      },
      { type: 'reasoning_delta', delta: 'first' },
      { type: 'text_delta', delta: 'Working' },
      {
        type: 'tool_call_delta',
        index: 0,
        nameDelta: 'file',
        argumentsDelta: 'th":"app/page.tsx"}',
      },
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
      {
        type: 'usage',
        usage: {
          inputTokens: 20,
          outputTokens: 8,
          totalTokens: 28,
          cachedInputTokens: 12,
          cacheMissInputTokens: 8,
          reasoningTokens: 5,
        },
      },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-key');
    expect(headers.get('x-client')).toBe('quantpilot');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 123,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    });
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'must replay',
      tool_calls: [
        {
          id: 'old-call',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
    });
  });

  it('surfaces bounded HTTP error details and retry metadata', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'x-request-id': 'request-429', 'retry-after': '2' },
      })
    ) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({ apiKey: 'secret', fetchImpl, maxRetries: 0 });

    let caught: unknown;
    try {
      await collect(provider.complete(request()));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeepSeekProviderError);
    expect(caught).toMatchObject({
      code: 'HTTP_ERROR',
      status: 429,
      responseBody: '{"error":{"message":"rate limited"}}',
      requestId: 'request-429',
      retryAfterMs: 2_000,
    });
  });

  it('honors Retry-After and emits retry metadata before a successful retry', async () => {
    const responses = [
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '2' },
      }),
      sseResponse([
        {
          id: 'response-after-retry',
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: 'stop' }],
        },
      ]),
    ];
    const fetchMock = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected fetch call.');
      return response;
    });
    const sleepImpl = vi.fn(async () => undefined);
    const provider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 5_000,
      sleepImpl,
    });

    const events = await collect(provider.complete(request()));

    expect(events[0]).toEqual({
      type: 'provider_retry',
      attempt: 2,
      maxAttempts: 2,
      delayMs: 2_000,
      code: 'HTTP_ERROR',
      status: 429,
    });
    expect(events).toContainEqual({
      type: 'response_start',
      responseId: 'response-after-retry',
      model: 'deepseek-v4-flash',
    });
    expect(events).toContainEqual({ type: 'text_delta', delta: 'recovered' });
    expect(events).toContainEqual({ type: 'finish', reason: 'stop', rawReason: 'stop' });
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(2_000, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure before a response is received', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('socket reset'))
      .mockResolvedValueOnce(
        sseResponse([
          {
            id: 'response-after-network-error',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ])
      );
    const sleepImpl = vi.fn(async () => undefined);
    const provider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
      initialRetryDelayMs: 100,
      maxRetryDelayMs: 100,
      retryRandom: () => 1,
      sleepImpl,
    });

    const events = await collect(provider.complete(request()));

    expect(events[0]).toEqual({
      type: 'provider_retry',
      attempt: 2,
      maxAttempts: 2,
      delayMs: 100,
      code: 'NETWORK_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(100, undefined);
  });

  it('does not retry non-retryable HTTP errors', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":{"message":"invalid key"}}', {
        status: 401,
        statusText: 'Unauthorized',
      })
    );
    const sleepImpl = vi.fn(async () => undefined);
    const provider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 2,
      sleepImpl,
    });

    await expect(collect(provider.complete(request()))).rejects.toMatchObject({
      name: 'DeepSeekProviderError',
      code: 'HTTP_ERROR',
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('fails closed before fetch when the serialized request exceeds its byte budget', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const provider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: fetchMock,
      maxRequestBytes: 100,
    });

    await expect(
      collect(provider.complete(request({
        messages: [{ role: 'user', content: '🚀'.repeat(100) }],
      })))
    ).rejects.toMatchObject({
      name: 'DeepSeekProviderError',
      code: 'REQUEST_TOO_LARGE',
      message: expect.stringContaining('100 bytes'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams at most the configured HTTP error-body byte limit', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('0123456789'.repeat(10_000), {
        status: 500,
        statusText: 'Internal Server Error',
      })
    ) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl,
      maxErrorBodyBytes: 32,
      maxRetries: 0,
    });

    let caught: unknown;
    try {
      await collect(provider.complete(request()));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeepSeekProviderError);
    expect(caught).toMatchObject({
      code: 'HTTP_ERROR',
      responseBody: '01234567890123456789012345678901',
    });
  });

  it('rejects oversized SSE frames and total streams', async () => {
    const oversizedFrame = sseResponse([{
      id: 'response-1',
      choices: [{ index: 0, delta: { content: 'x'.repeat(300) }, finish_reason: 'stop' }],
    }]);
    const frameProvider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: vi.fn(async () => oversizedFrame) as unknown as typeof fetch,
      maxSseFrameChars: 100,
    });
    await expect(collect(frameProvider.complete(request()))).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: expect.stringContaining('SSE frame'),
    });

    const streamProvider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: vi.fn(async () => sseResponse([{
        id: 'response-1',
        choices: [{ index: 0, delta: { content: 'stream bytes' }, finish_reason: 'stop' }],
      }])) as unknown as typeof fetch,
      maxStreamBytes: 20,
    });
    await expect(collect(streamProvider.complete(request()))).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: expect.stringContaining('stream exceeded'),
    });
  });

  it.each([
    {
      label: 'a semantic chunk without a response ID',
      chunks: [
        {
          choices: [{ index: 0, delta: { content: 'orphaned' }, finish_reason: 'stop' }],
        },
      ],
      message: 'without a response ID',
    },
    {
      label: 'a response ID change within one stream',
      chunks: [
        {
          id: 'response-1',
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
        },
        {
          id: 'response-2',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ],
      message: 'changed the response ID',
    },
    {
      label: 'a tool-call ID change for one index',
      chunks: [
        {
          id: 'response-1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    function: { name: 'lookup', arguments: '{' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'response-1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-2', function: { arguments: '}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ],
      message: 'changed the tool-call ID for index 0',
    },
    {
      label: 'a choice without an index',
      chunks: [
        {
          id: 'response-1',
          choices: [{ delta: {}, finish_reason: 'stop' }],
        },
      ],
      message: 'expected index 0',
    },
    {
      label: 'a non-primary choice index',
      chunks: [
        {
          id: 'response-1',
          choices: [{ index: 1, delta: {}, finish_reason: 'stop' }],
        },
      ],
      message: 'expected index 0',
    },
  ])('rejects $label without retrying', async ({ chunks, message }) => {
    const fetchMock = vi.fn(async () => sseResponse(chunks));
    const sleepImpl = vi.fn(async () => undefined);
    const provider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 3,
      sleepImpl,
    });

    await expect(collect(provider.complete(request()))).rejects.toMatchObject({
      name: 'DeepSeekProviderError',
      code: 'PROTOCOL_ERROR',
      message: expect.stringContaining(message),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'text',
      delta: { content: '123456' },
      options: { maxTextChars: 5 },
      message: 'response text',
    },
    {
      label: 'reasoning',
      delta: { reasoning_content: '123456' },
      options: { maxReasoningChars: 5 },
      message: 'reasoning',
    },
    {
      label: 'tool arguments',
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-1',
          function: { name: 'lookup', arguments: '123456' },
        }],
      },
      options: { maxToolArgumentChars: 5 },
      message: 'tool arguments',
    },
  ])('rejects oversized $label deltas', async ({ delta, options, message }) => {
    const provider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: vi.fn(async () => sseResponse([
        {
          id: 'response-1',
          choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
          id: 'response-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ])) as unknown as typeof fetch,
      ...options,
    });

    await expect(collect(provider.complete(request()))).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: expect.stringContaining(message),
    });
  });

  it('passes AbortSignal to fetch and preserves cancellation errors', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('cancelled by user', 'AbortError');
    controller.abort(cancellation);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = new DeepSeekProvider({ apiKey: 'secret', fetchImpl });

    await expect(
      collect(provider.complete(request({ signal: controller.signal })))
    ).rejects.toBe(cancellation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a truncated stream without a finish reason', async () => {
    const fetchMock = vi.fn(async () => {
      const data = new TextEncoder().encode(
        `data: ${JSON.stringify({
          id: 'response-1',
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
        })}\n\n`
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        })
      );
    });
    const sleepImpl = vi.fn(async () => undefined);
    const provider = new DeepSeekProvider({
      apiKey: 'secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 3,
      sleepImpl,
    });

    await expect(collect(provider.complete(request()))).rejects.toMatchObject({
      name: 'DeepSeekProviderError',
      code: 'PROTOCOL_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepImpl).not.toHaveBeenCalled();
  });
});
