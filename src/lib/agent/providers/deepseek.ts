import type {
  MoAgentFinishReason,
  MoAgentMessage,
  MoAgentModelEvent,
  MoAgentModelProvider,
  MoAgentModelRequest,
  MoAgentTokenUsage,
  MoAgentToolChoice,
} from '../types';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MAX_ERROR_BODY_BYTES = 16_384;
const DEFAULT_MAX_REQUEST_BYTES = 2_000_000;
const DEFAULT_MAX_SSE_FRAME_CHARS = 1_000_000;
const DEFAULT_MAX_STREAM_BYTES = 8_000_000;
const DEFAULT_MAX_TEXT_CHARS = 128_000;
const DEFAULT_MAX_REASONING_CHARS = 256_000;
const DEFAULT_MAX_TOOL_ARGUMENT_CHARS = 64_000;
const DEFAULT_MAX_TOOL_CALLS = 32;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
const MAX_TOOL_NAME_CHARS = 256;

type Fetch = typeof globalThis.fetch;

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: Fetch;
  headers?: Readonly<Record<string, string>>;
  maxErrorBodyBytes?: number;
  maxRequestBytes?: number;
  maxSseFrameChars?: number;
  maxStreamBytes?: number;
  maxTextChars?: number;
  maxReasoningChars?: number;
  maxToolArgumentChars?: number;
  maxToolCalls?: number;
  /** Retries only transport/retryable HTTP failures before a response stream starts. */
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  retryRandom?: () => number;
  sleepImpl?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  /** DeepSeek uses proprietary thinking fields; generic OpenAI-compatible APIs omit them. */
  reasoningWireFormat?: 'deepseek' | 'none';
}

interface DeepSeekProviderLimits {
  maxErrorBodyBytes: number;
  maxRequestBytes: number;
  maxSseFrameChars: number;
  maxStreamBytes: number;
  maxTextChars: number;
  maxReasoningChars: number;
  maxToolArgumentChars: number;
  maxToolCalls: number;
}

export interface DeepSeekProviderErrorOptions {
  code: 'HTTP_ERROR' | 'NETWORK_ERROR' | 'PROTOCOL_ERROR' | 'REQUEST_TOO_LARGE';
  status?: number;
  responseBody?: string;
  requestId?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class DeepSeekProviderError extends Error {
  readonly code: DeepSeekProviderErrorOptions['code'];
  readonly status?: number;
  readonly responseBody?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: DeepSeekProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'DeepSeekProviderError';
    this.code = options.code;
    this.status = options.status;
    this.responseBody = options.responseBody;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

interface DeepSeekStreamChunk {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

interface DeepSeekChoice {
  index?: unknown;
  delta?: unknown;
  finish_reason?: unknown;
}

interface DeepSeekDelta {
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
}

interface DeepSeekToolCallDelta {
  index?: unknown;
  id?: unknown;
  function?: unknown;
}

interface DeepSeekFunctionDelta {
  name?: unknown;
  arguments?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function configuredPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return candidate;
}

function configuredNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return candidate;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 ||
    status === 500 || status === 502 || status === 503 || status === 504;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function serializeMessage(
  message: MoAgentMessage,
  includeReasoningContent: boolean,
): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant': {
      const serialized: Record<string, unknown> = {
        role: 'assistant',
        content: message.content,
      };
      if (includeReasoningContent && message.reasoningContent !== undefined) {
        serialized.reasoning_content = message.reasoningContent;
      }
      if (message.toolCalls?.length) {
        serialized.tool_calls = message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
        }));
      }
      return serialized;
    }
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

function serializeToolChoice(choice: MoAgentToolChoice): unknown {
  return typeof choice === 'string'
    ? choice
    : {
        type: 'function',
        function: { name: choice.name },
      };
}

function completionUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('DeepSeek baseUrl cannot be empty.');
  }
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function normalizeFinishReason(rawReason: string): MoAgentFinishReason {
  switch (rawReason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'insufficient_system_resource':
      return 'resource_exhausted';
    default:
      return 'other';
  }
}

function parseUsage(value: unknown): MoAgentTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = positiveInteger(value.prompt_tokens);
  const outputTokens = positiveInteger(value.completion_tokens);
  const totalTokens = positiveInteger(value.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  if (totalTokens !== inputTokens + outputTokens) return undefined;

  const details = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : undefined;
  const proprietaryCacheHitTokens = positiveInteger(value.prompt_cache_hit_tokens);
  const proprietaryCacheMissTokens = positiveInteger(value.prompt_cache_miss_tokens);
  const standardCachedInputTokens = isRecord(value.prompt_tokens_details)
    ? positiveInteger(value.prompt_tokens_details.cached_tokens)
    : undefined;
  const reasoningTokens = details ? positiveInteger(details.reasoning_tokens) : undefined;
  if (
    (proprietaryCacheHitTokens === undefined) !==
    (proprietaryCacheMissTokens === undefined)
  ) {
    return undefined;
  }
  if (
    proprietaryCacheHitTokens !== undefined &&
    proprietaryCacheMissTokens !== undefined &&
    proprietaryCacheHitTokens + proprietaryCacheMissTokens !== inputTokens
  ) {
    return undefined;
  }
  if (standardCachedInputTokens !== undefined && standardCachedInputTokens > inputTokens) {
    return undefined;
  }
  if (reasoningTokens !== undefined && reasoningTokens > outputTokens) return undefined;
  const cachedInputTokens = proprietaryCacheHitTokens ?? standardCachedInputTokens;
  const cacheMissInputTokens = proprietaryCacheMissTokens ??
    (standardCachedInputTokens === undefined
      ? undefined
      : inputTokens - standardCachedInputTokens);
  const cacheEstimated = cachedInputTokens === undefined;
  const effectiveCachedInputTokens = cachedInputTokens ?? 0;
  const effectiveCacheMissInputTokens = cacheMissInputTokens ?? inputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: effectiveCachedInputTokens,
    cacheMissInputTokens: effectiveCacheMissInputTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheEstimated ? { usageSource: 'cache_estimated' as const } : {}),
  };
}

function protocolError(message: string, cause?: unknown): DeepSeekProviderError {
  return new DeepSeekProviderError(message, { code: 'PROTOCOL_ERROR', cause });
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  limits: Pick<DeepSeekProviderLimits, 'maxSseFrameChars' | 'maxStreamBytes'>,
  signal?: AbortSignal
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamBytes = 0;
  let completed = false;

  const frames = function* (flush: boolean): Generator<string> {
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.length > limits.maxSseFrameChars) {
        throw protocolError(
          `DeepSeek SSE frame exceeded ${limits.maxSseFrameChars} characters.`
        );
      }
      yield frame;
      boundary = buffer.indexOf('\n\n');
    }
    if (flush && buffer.trim()) {
      const frame = buffer;
      buffer = '';
      if (frame.length > limits.maxSseFrameChars) {
        throw protocolError(
          `DeepSeek SSE frame exceeded ${limits.maxSseFrameChars} characters.`
        );
      }
      yield frame;
    }
  };

  const dataFromFrame = (frame: string): string | undefined => {
    const dataLines = frame
      .split('\n')
      .filter((line) => line === 'data' || line.startsWith('data:'))
      .map((line) => {
        const data = line === 'data' ? '' : line.slice(5);
        return data.startsWith(' ') ? data.slice(1) : data;
      });
    return dataLines.length ? dataLines.join('\n') : undefined;
  };

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        for (const frame of frames(true)) {
          const data = dataFromFrame(frame);
          if (data !== undefined) {
            yield data;
          }
        }
        completed = true;
        return;
      }

      streamBytes += value.byteLength;
      if (streamBytes > limits.maxStreamBytes) {
        await reader.cancel('DeepSeek stream byte limit reached.').catch(() => undefined);
        throw protocolError(
          `DeepSeek stream exceeded ${limits.maxStreamBytes} bytes.`
        );
      }
      buffer += decoder.decode(value, { stream: true });
      for (const frame of frames(false)) {
        const data = dataFromFrame(frame);
        if (data !== undefined) {
          yield data;
        }
      }
      if (buffer.length > limits.maxSseFrameChars) {
        await reader.cancel('DeepSeek SSE frame limit reached.').catch(() => undefined);
        throw protocolError(
          `DeepSeek SSE frame exceeded ${limits.maxSseFrameChars} characters.`
        );
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel('DeepSeek stream consumer stopped.').catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - bytes;
      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(accepted);
      bytes += accepted.byteLength;
      if (accepted.byteLength < value.byteLength || bytes >= maxBytes) {
        await reader.cancel('DeepSeek error-body byte limit reached.').catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(
    chunks.length === 1
      ? chunks[0]
      : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  );
}

export class DeepSeekProvider implements MoAgentModelProvider {
  readonly name = 'deepseek';

  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetchImpl: Fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly limits: DeepSeekProviderLimits;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly retryRandom: () => number;
  private readonly sleepImpl: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly reasoningWireFormat: 'deepseek' | 'none';

  constructor(options: DeepSeekProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error('DeepSeek apiKey cannot be empty.');
    }
    this.apiKey = options.apiKey.trim();
    this.url = completionUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? {};
    this.limits = {
      maxErrorBodyBytes: configuredPositiveInteger(
        options.maxErrorBodyBytes,
        DEFAULT_MAX_ERROR_BODY_BYTES,
        'maxErrorBodyBytes'
      ),
      maxRequestBytes: configuredPositiveInteger(
        options.maxRequestBytes,
        DEFAULT_MAX_REQUEST_BYTES,
        'maxRequestBytes'
      ),
      maxSseFrameChars: configuredPositiveInteger(
        options.maxSseFrameChars,
        DEFAULT_MAX_SSE_FRAME_CHARS,
        'maxSseFrameChars'
      ),
      maxStreamBytes: configuredPositiveInteger(
        options.maxStreamBytes,
        DEFAULT_MAX_STREAM_BYTES,
        'maxStreamBytes'
      ),
      maxTextChars: configuredPositiveInteger(
        options.maxTextChars,
        DEFAULT_MAX_TEXT_CHARS,
        'maxTextChars'
      ),
      maxReasoningChars: configuredPositiveInteger(
        options.maxReasoningChars,
        DEFAULT_MAX_REASONING_CHARS,
        'maxReasoningChars'
      ),
      maxToolArgumentChars: configuredPositiveInteger(
        options.maxToolArgumentChars,
        DEFAULT_MAX_TOOL_ARGUMENT_CHARS,
        'maxToolArgumentChars'
      ),
      maxToolCalls: configuredPositiveInteger(
        options.maxToolCalls,
        DEFAULT_MAX_TOOL_CALLS,
        'maxToolCalls'
      ),
    };
    this.maxRetries = configuredNonNegativeInteger(
      options.maxRetries,
      DEFAULT_MAX_RETRIES,
      'maxRetries'
    );
    if (this.maxRetries > 10) {
      throw new Error('maxRetries cannot exceed 10.');
    }
    this.initialRetryDelayMs = configuredNonNegativeInteger(
      options.initialRetryDelayMs,
      DEFAULT_INITIAL_RETRY_DELAY_MS,
      'initialRetryDelayMs'
    );
    this.maxRetryDelayMs = configuredNonNegativeInteger(
      options.maxRetryDelayMs,
      DEFAULT_MAX_RETRY_DELAY_MS,
      'maxRetryDelayMs'
    );
    if (this.maxRetryDelayMs < this.initialRetryDelayMs) {
      throw new Error('maxRetryDelayMs must be greater than or equal to initialRetryDelayMs.');
    }
    this.retryRandom = options.retryRandom ?? Math.random;
    this.sleepImpl = options.sleepImpl ?? abortableSleep;
    this.reasoningWireFormat = options.reasoningWireFormat ?? 'deepseek';
  }

  private retryDelayMs(failedAttempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(this.maxRetryDelayMs, Math.max(0, retryAfterMs));
    }
    const exponent = Math.min(30, Math.max(0, failedAttempt - 1));
    const ceiling = Math.min(
      this.maxRetryDelayMs,
      this.initialRetryDelayMs * (2 ** exponent)
    );
    const random = Math.min(1, Math.max(0, this.retryRandom()));
    return Math.round(ceiling * (0.5 + random * 0.5));
  }

  async *complete(request: MoAgentModelRequest): AsyncGenerator<MoAgentModelEvent> {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) =>
        serializeMessage(message, this.reasoningWireFormat === 'deepseek')),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    if (request.toolChoice !== undefined) {
      body.tool_choice = serializeToolChoice(request.toolChoice);
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.reasoning !== undefined && this.reasoningWireFormat === 'deepseek') {
      body.thinking = { type: request.reasoning.enabled ? 'enabled' : 'disabled' };
      if (request.reasoning.effort !== undefined) {
        body.reasoning_effort = request.reasoning.effort;
      }
    }

    const serializedBody = JSON.stringify(body);
    const requestBytes = utf8Bytes(serializedBody);
    if (requestBytes > this.limits.maxRequestBytes) {
      throw new DeepSeekProviderError(
        `DeepSeek request body exceeded ${this.limits.maxRequestBytes} bytes.`,
        { code: 'REQUEST_TOO_LARGE' }
      );
    }

    const headers = new Headers(this.headers);
    headers.set('Accept', 'text/event-stream');
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    headers.set('Content-Type', 'application/json');
    const maxAttempts = this.maxRetries + 1;
    let response: Response | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let candidate: Response;
      try {
        candidate = await this.fetchImpl(this.url, {
          method: 'POST',
          headers,
          body: serializedBody,
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal?.aborted || isAbortError(error)) {
          throw error;
        }
        const networkError = new DeepSeekProviderError(
          'DeepSeek request failed before a response was received.',
          { code: 'NETWORK_ERROR', cause: error }
        );
        if (attempt >= maxAttempts) throw networkError;
        const delayMs = this.retryDelayMs(attempt);
        yield {
          type: 'provider_retry',
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          code: networkError.code,
        };
        await this.sleepImpl(delayMs, request.signal);
        continue;
      }

      if (candidate.ok) {
        response = candidate;
        break;
      }

      const retryAfterMs = parseRetryAfter(candidate.headers.get('retry-after'));
      if (isRetryableStatus(candidate.status) && attempt < maxAttempts) {
        const delayMs = this.retryDelayMs(attempt, retryAfterMs);
        await candidate.body?.cancel('Retrying retryable DeepSeek response.').catch(() => undefined);
        yield {
          type: 'provider_retry',
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          code: 'HTTP_ERROR',
          status: candidate.status,
        };
        await this.sleepImpl(delayMs, request.signal);
        continue;
      }

      const responseBody = await readBoundedText(
        candidate.body,
        this.limits.maxErrorBodyBytes,
        request.signal
      );
      throw new DeepSeekProviderError(
        `DeepSeek request failed with HTTP ${candidate.status}${
          candidate.statusText ? ` ${candidate.statusText}` : ''
        }.`,
        {
          code: 'HTTP_ERROR',
          status: candidate.status,
          responseBody,
          requestId:
            candidate.headers.get('x-request-id') ??
            candidate.headers.get('request-id') ??
            undefined,
          retryAfterMs,
        }
      );
    }

    if (!response) {
      throw new DeepSeekProviderError('DeepSeek retries ended without a response.', {
        code: 'NETWORK_ERROR',
      });
    }

    if (!response.body) {
      throw protocolError('DeepSeek returned a successful response without a stream body.');
    }

    let responseId: string | undefined;
    let finished = false;
    let textChars = 0;
    let reasoningChars = 0;
    const toolArgumentChars = new Map<number, number>();
    const toolNameChars = new Map<number, number>();
    const toolCallIds = new Map<number, string>();
    for await (const data of readSseData(response.body, this.limits, request.signal)) {
      if (data.trim() === '[DONE]') {
        if (!finished) {
          throw protocolError('DeepSeek stream ended before a finish reason was received.');
        }
        return;
      }

      let chunk: DeepSeekStreamChunk;
      try {
        chunk = JSON.parse(data) as DeepSeekStreamChunk;
      } catch (error) {
        throw protocolError('DeepSeek returned malformed JSON in its event stream.', error);
      }
      if (!isRecord(chunk)) {
        throw protocolError('DeepSeek returned a non-object event-stream chunk.');
      }

      const chunkResponseId =
        typeof chunk.id === 'string' && chunk.id.trim() ? chunk.id : undefined;
      const usage = parseUsage(chunk.usage);
      if (chunk.usage !== undefined && chunk.usage !== null && usage === undefined) {
        throw protocolError('DeepSeek returned an inconsistent token-usage payload.');
      }
      const hasChoices = Array.isArray(chunk.choices) && chunk.choices.length > 0;
      const hasSemanticPayload = usage !== undefined || hasChoices;

      if (hasSemanticPayload && !chunkResponseId) {
        throw protocolError('DeepSeek returned a semantic stream chunk without a response ID.');
      }
      if (chunkResponseId && responseId && chunkResponseId !== responseId) {
        throw protocolError('DeepSeek changed the response ID within one event stream.');
      }
      if (!responseId && chunkResponseId) {
        responseId = chunkResponseId;
        yield {
          type: 'response_start',
          responseId,
          model: typeof chunk.model === 'string' ? chunk.model : request.model,
        };
      }

      if (usage) {
        yield { type: 'usage', usage };
      }

      if (!Array.isArray(chunk.choices)) {
        continue;
      }
      for (const rawChoice of chunk.choices) {
        if (!isRecord(rawChoice)) {
          throw protocolError('DeepSeek returned a non-object choice.');
        }
        const choice = rawChoice as DeepSeekChoice;
        if (!Number.isSafeInteger(choice.index) || choice.index !== 0) {
          throw protocolError('DeepSeek returned a choice without the expected index 0.');
        }
        if (isRecord(choice.delta)) {
          const delta = choice.delta as DeepSeekDelta;
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            reasoningChars += delta.reasoning_content.length;
            if (reasoningChars > this.limits.maxReasoningChars) {
              throw protocolError(
                `DeepSeek reasoning exceeded ${this.limits.maxReasoningChars} characters.`
              );
            }
            yield { type: 'reasoning_delta', delta: delta.reasoning_content };
          }
          if (typeof delta.content === 'string' && delta.content) {
            textChars += delta.content.length;
            if (textChars > this.limits.maxTextChars) {
              throw protocolError(
                `DeepSeek response text exceeded ${this.limits.maxTextChars} characters.`
              );
            }
            yield { type: 'text_delta', delta: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const rawToolCall of delta.tool_calls) {
              if (!isRecord(rawToolCall)) {
                continue;
              }
              const toolCall = rawToolCall as DeepSeekToolCallDelta;
              if (!Number.isSafeInteger(toolCall.index) || (toolCall.index as number) < 0) {
                throw protocolError('DeepSeek returned a tool-call delta without a valid index.');
              }
              const toolCallIndex = toolCall.index as number;
              const toolCallId =
                typeof toolCall.id === 'string' && toolCall.id.trim()
                  ? toolCall.id
                  : undefined;
              if (!toolArgumentChars.has(toolCallIndex)) {
                if (!toolCallId) {
                  throw protocolError(
                    'DeepSeek started a tool-call stream without a non-empty ID.'
                  );
                }
                if (toolArgumentChars.size >= this.limits.maxToolCalls) {
                  throw protocolError(
                    `DeepSeek response exceeded ${this.limits.maxToolCalls} tool calls.`
                  );
                }
                toolArgumentChars.set(toolCallIndex, 0);
                toolNameChars.set(toolCallIndex, 0);
              }
              const existingToolCallId = toolCallIds.get(toolCallIndex);
              if (
                toolCallId !== undefined &&
                existingToolCallId !== undefined &&
                toolCallId !== existingToolCallId
              ) {
                throw protocolError(
                  `DeepSeek changed the tool-call ID for index ${toolCallIndex}.`
                );
              }
              if (toolCallId !== undefined) {
                toolCallIds.set(toolCallIndex, toolCallId);
              }
              const fn = isRecord(toolCall.function)
                ? (toolCall.function as DeepSeekFunctionDelta)
                : undefined;
              if (typeof fn?.name === 'string') {
                const nextNameChars = (toolNameChars.get(toolCallIndex) ?? 0) + fn.name.length;
                if (nextNameChars > MAX_TOOL_NAME_CHARS) {
                  throw protocolError(
                    `DeepSeek tool name exceeded ${MAX_TOOL_NAME_CHARS} characters.`
                  );
                }
                toolNameChars.set(toolCallIndex, nextNameChars);
              }
              if (typeof fn?.arguments === 'string') {
                const nextArgumentChars =
                  (toolArgumentChars.get(toolCallIndex) ?? 0) + fn.arguments.length;
                if (nextArgumentChars > this.limits.maxToolArgumentChars) {
                  throw protocolError(
                    `DeepSeek tool arguments exceeded ${this.limits.maxToolArgumentChars} characters.`
                  );
                }
                toolArgumentChars.set(toolCallIndex, nextArgumentChars);
              }
              yield {
                type: 'tool_call_delta',
                index: toolCallIndex,
                ...(toolCallId !== undefined ? { id: toolCallId } : {}),
                ...(typeof fn?.name === 'string' ? { nameDelta: fn.name } : {}),
                ...(typeof fn?.arguments === 'string'
                  ? { argumentsDelta: fn.arguments }
                  : {}),
              };
            }
          }
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finished = true;
          yield {
            type: 'finish',
            reason: normalizeFinishReason(choice.finish_reason),
            rawReason: choice.finish_reason,
          };
        }
      }
    }

    if (!finished) {
      throw protocolError('DeepSeek stream closed before a finish reason was received.');
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
