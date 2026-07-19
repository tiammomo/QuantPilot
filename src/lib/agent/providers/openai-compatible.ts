import type {
  MoAgentMessage,
  MoAgentModelEvent,
  MoAgentModelProvider,
  MoAgentModelRequest,
} from '../types';
import {
  DeepSeekProvider,
  DeepSeekProviderError,
  type DeepSeekProviderErrorOptions,
  type DeepSeekProviderOptions,
} from './deepseek';

export type OpenAICompatibleProviderOptions = Omit<
  DeepSeekProviderOptions,
  'reasoningWireFormat'
> & {
  providerName?: string;
};

export class OpenAICompatibleProviderError extends Error {
  readonly code: DeepSeekProviderErrorOptions['code'];
  readonly status?: number;
  readonly responseBody?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(error: DeepSeekProviderError) {
    super(error.message.replaceAll('DeepSeek', 'OpenAI-compatible provider'), {
      cause: error,
    });
    this.name = 'OpenAICompatibleProviderError';
    this.code = error.code;
    this.status = error.status;
    this.responseBody = error.responseBody;
    this.requestId = error.requestId;
    this.retryAfterMs = error.retryAfterMs;
  }
}

function mergeLeadingSystemMessages(
  messages: readonly MoAgentMessage[],
): readonly MoAgentMessage[] {
  const leadingSystemCount = messages.findIndex((message) => message.role !== 'system');
  const count = leadingSystemCount < 0 ? messages.length : leadingSystemCount;
  if (count <= 1) return messages;
  return [
    {
      role: 'system' as const,
      content: messages
        .slice(0, count)
        .map((message) => message.content)
        .join('\n\n'),
    },
    ...messages.slice(count),
  ];
}

/**
 * OpenAI-compatible chat-completions adapter backed by the hardened SSE parser.
 * It deliberately omits DeepSeek-only thinking fields and reasoning replay.
 */
export class OpenAICompatibleProvider implements MoAgentModelProvider {
  readonly name: string;
  private readonly delegate: DeepSeekProvider;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.providerName?.trim() || 'openai';
    const { providerName: _providerName, ...delegateOptions } = options;
    this.delegate = new DeepSeekProvider({
      ...delegateOptions,
      reasoningWireFormat: 'none',
    });
  }

  async *complete(request: MoAgentModelRequest): AsyncGenerator<MoAgentModelEvent> {
    try {
      yield* this.delegate.complete({
        ...request,
        // OpenAI permits multiple system messages, while common local Qwen
        // Jinja templates accept exactly one system message at the beginning.
        // MoAgent has two leading authorities (kernel policy and trusted
        // context protocol); ordered concatenation preserves both without
        // teaching the core runtime a provider-specific chat-template rule.
        messages: mergeLeadingSystemMessages(request.messages),
      });
    } catch (error) {
      if (error instanceof DeepSeekProviderError) {
        throw new OpenAICompatibleProviderError(error);
      }
      throw error;
    }
  }
}
