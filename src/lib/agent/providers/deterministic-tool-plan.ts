import type {
  PiAgentMessage,
  PiAgentModelEvent,
  PiAgentModelProvider,
  PiAgentModelRequest,
} from '../types';

export interface PiAgentDeterministicToolStep {
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}

export interface PiAgentDeterministicToolPlanOptions {
  name?: string;
  steps: readonly PiAgentDeterministicToolStep[];
}

function latestToolOutcome(
  messages: readonly PiAgentMessage[],
  expectedToolName: string,
  expectedToolCallId: string,
): boolean | null {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'tool');
  if (!message || message.role !== 'tool') return null;
  if (
    message.name !== expectedToolName ||
    message.toolCallId !== expectedToolCallId
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(message.content) as { ok?: unknown };
    return typeof parsed.ok === 'boolean' ? parsed.ok : null;
  } catch {
    return null;
  }
}

/**
 * Provider-compatible executor for trusted, precompiled tool plans. It lets the
 * ordinary PI Agent ledger, fencing, event and terminal gates remain in force
 * while making no network/model request and reporting exactly zero tokens.
 */
export class PiAgentDeterministicToolPlanProvider implements PiAgentModelProvider {
  readonly name: string;
  private readonly steps: readonly PiAgentDeterministicToolStep[];
  private cursor = 0;
  private issuedStep = false;

  constructor(options: PiAgentDeterministicToolPlanOptions) {
    if (options.steps.length === 0) {
      throw new Error('A deterministic PI Agent tool plan requires at least one step.');
    }
    if (options.steps.some((step) => !step.name.trim())) {
      throw new Error('Deterministic PI Agent tool steps require a non-empty tool name.');
    }
    this.name = options.name ?? 'pi-agent-deterministic';
    this.steps = Object.freeze(options.steps.map((step) => Object.freeze({
      name: step.name,
      arguments: Object.freeze(structuredClone(step.arguments)),
    })));
  }

  async *complete(request: PiAgentModelRequest): AsyncIterable<PiAgentModelEvent> {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }

    if (this.issuedStep) {
      const previousStep = this.steps[this.cursor];
      const outcome = previousStep
        ? latestToolOutcome(
            request.messages,
            previousStep.name,
            `deterministic_step_${this.cursor + 1}`,
          )
        : false;
      if (outcome !== true) {
        yield {
          type: 'response_start',
          responseId: `deterministic_failed_${this.cursor}`,
          model: request.model,
        };
        yield {
          type: 'text_delta',
          delta: 'The trusted deterministic step failed; the run is stopping for platform recovery.',
        };
        yield {
          type: 'usage',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      this.cursor += 1;
      this.issuedStep = false;
    }

    const step = this.steps[this.cursor];
    if (!step) {
      yield {
        type: 'response_start',
        responseId: `deterministic_complete_${this.cursor}`,
        model: request.model,
      };
      yield {
        type: 'usage',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
      yield { type: 'finish', reason: 'stop' };
      return;
    }

    if (!request.tools?.some((tool) => tool.name === step.name)) {
      throw new Error(`Deterministic PI Agent step requires unavailable tool: ${step.name}`);
    }

    const stepNumber = this.cursor + 1;
    this.issuedStep = true;
    yield {
      type: 'response_start',
      responseId: `deterministic_${stepNumber}`,
      model: request.model,
    };
    yield {
      type: 'tool_call_delta',
      index: 0,
      id: `deterministic_step_${stepNumber}`,
      nameDelta: step.name,
      argumentsDelta: JSON.stringify(step.arguments),
    };
    yield {
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    yield { type: 'finish', reason: 'tool_calls' };
  }
}
