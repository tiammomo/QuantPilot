import { describe, expect, it, vi } from 'vitest';

import type {
  PiAgentEvent,
  PiAgentMessage,
  PiAgentModelEvent,
  PiAgentModelProvider,
  PiAgentModelRequest,
  PiAgentTokenUsage,
  PiAgentTool,
} from '../types';
import {
  PiAgentRunEngine,
  usageFromPi,
  usageToPi,
} from './run-engine';

type ProviderScript = readonly PiAgentModelEvent[];

class ScriptedProvider implements PiAgentModelProvider {
  readonly name = 'pi-scripted';
  readonly requests: PiAgentModelRequest[] = [];
  private readonly scripts: ProviderScript[];

  constructor(scripts: ProviderScript[]) {
    this.scripts = [...scripts];
  }

  complete(request: PiAgentModelRequest): AsyncIterable<PiAgentModelEvent> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
      tools: request.tools?.map((tool) => structuredClone(tool)),
    });
    const script = this.scripts.shift();
    return {
      async *[Symbol.asyncIterator]() {
        if (!script) throw new Error('No scripted provider turn remains.');
        for (const event of script) yield event;
      },
    };
  }
}

const initialMessages: PiAgentMessage[] = [{
  role: 'user',
  content: 'Complete the governed task.',
}];

function usage(options: {
  input: number;
  output: number;
  cached?: number;
  cacheMiss?: number;
}): PiAgentModelEvent {
  const cachedInputTokens = options.cached ?? 0;
  const cacheMissInputTokens = options.cacheMiss ??
    options.input - cachedInputTokens;
  return {
    type: 'usage',
    usage: {
      inputTokens: options.input,
      outputTokens: options.output,
      totalTokens: options.input + options.output,
      cachedInputTokens,
      cacheMissInputTokens,
    },
  };
}

function toolTurn(
  calls: Array<{ id: string; name: string; arguments: string }>,
  turnUsage: PiAgentModelEvent = usage({ input: 1, output: 1 }),
): ProviderScript {
  return [
    {
      type: 'response_start',
      responseId: `response-${calls.map((call) => call.id).join('-')}`,
      model: 'test-model',
    },
    ...calls.map((call, index): PiAgentModelEvent => ({
      type: 'tool_call_delta',
      index,
      id: call.id,
      nameDelta: call.name,
      argumentsDelta: call.arguments,
    })),
    turnUsage,
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ];
}

function objectSchema(
  properties: Record<string, Record<string, unknown>> = {},
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function terminalTool(
  execute = vi.fn(async (input: unknown) => ({
    ok: true as const,
    data: input,
  })),
): PiAgentTool {
  return {
    name: 'submit_result',
    description: 'Submit the completed result.',
    inputSchema: objectSchema(
      { artifact: { type: 'string' } },
      ['artifact'],
    ),
    terminal: true,
    execute,
  };
}

describe('PiAgentRunEngine', () => {
  it('rejects unsafe run identifiers before starting PI', async () => {
    const provider = new ScriptedProvider([]);
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
    });

    await expect(engine.run({
      runId: 'unsafe\nrun',
      messages: initialMessages,
    })).rejects.toThrow('runId must be');
    expect(provider.requests).toHaveLength(0);
  });

  it('lets PI own a real multi-turn tool loop and preserves ordered usage', async () => {
    const provider = new ScriptedProvider([
      toolTurn(
        [{
          id: 'call-lookup',
          name: 'lookup',
          arguments: '{"symbol":"600519.SH"}',
        }],
        usage({ input: 10, output: 3, cached: 4, cacheMiss: 6 }),
      ),
      toolTurn(
        [{
          id: 'call-submit',
          name: 'submit_result',
          arguments: '{"artifact":"app/page.tsx"}',
        }],
        usage({ input: 20, output: 4, cached: 5, cacheMiss: 15 }),
      ),
    ]);
    const executionOrder: string[] = [];
    const lookup = vi.fn(async (input: unknown) => {
      executionOrder.push('lookup');
      return { ok: true as const, data: { input, price: 1_500 } };
    });
    const submit = vi.fn(async (input: unknown) => {
      executionOrder.push('submit');
      return { ok: true as const, data: input };
    });
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [
        {
          name: 'lookup',
          description: 'Look up a symbol.',
          inputSchema: objectSchema(
            { symbol: { type: 'string' } },
            ['symbol'],
          ),
          effect: 'read',
          execute: lookup,
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({
      runId: 'pi-multi-turn',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'completed',
      turns: 2,
      usage: {
        inputTokens: 30,
        outputTokens: 7,
        totalTokens: 37,
        cachedInputTokens: 9,
        cacheMissInputTokens: 21,
      },
      terminalToolCall: {
        id: 'call-submit',
        name: 'submit_result',
      },
    });
    expect(executionOrder).toEqual(['lookup', 'submit']);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].messages).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-lookup',
        name: 'lookup',
      }),
    );
    expect(result.messages[0]).toEqual(initialMessages[0]);
    const boundaries = events
      .filter((event) =>
        event.type === 'tool_started' ||
        event.type === 'tool_completed')
      .map((event) =>
        `${event.type}:${event.type === 'tool_started' ||
          event.type === 'tool_completed'
          ? event.toolCall.name
          : ''}`);
    expect(boundaries).toEqual([
      'tool_started:lookup',
      'tool_completed:lookup',
      'tool_started:submit_result',
      'tool_completed:submit_result',
    ]);
  });

  it('runs approval only after the original arguments pass the PI schema', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-publish-invalid',
        name: 'publish_report',
        arguments: '{}',
      }]),
      toolTurn([{
        id: 'call-submit',
        name: 'submit_result',
        arguments: '{"artifact":"report.md"}',
      }]),
    ]);
    const approval = vi.fn(async () => ({
      decision: 'approve' as const,
    }));
    const publish = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [
        {
          name: 'publish_report',
          description: 'Publish a report.',
          inputSchema: objectSchema(
            { title: { type: 'string' } },
            ['title'],
          ),
          effect: 'external_write',
          approval: {
            reason: 'Publishing is externally visible.',
            projectPublicInput: (input) =>
              input as Record<string, string>,
          },
          execute: publish,
        },
        terminalTool(),
      ],
      toolApprovalHandler: approval,
    });

    const result = await engine.run({
      runId: 'pi-schema-before-approval',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result.status).toBe('completed');
    expect(approval).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCall: expect.objectContaining({ name: 'publish_report' }),
    }));
    const failedResult = provider.requests[1].messages.find(
      (message) =>
        message.role === 'tool' &&
        message.toolCallId === 'call-publish-invalid',
    );
    expect(failedResult?.role === 'tool'
      ? failedResult.content
      : '').toContain('Validation failed');
  });

  it('revalidates an approved edit with the PI schema before durable start', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-publish',
        name: 'publish_report',
        arguments: '{"channel":"draft","title":"Initial"}',
      }]),
    ]);
    const publish = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [{
        name: 'publish_report',
        description: 'Publish a report.',
        inputSchema: objectSchema(
          {
            channel: { type: 'string' },
            title: { type: 'string' },
          },
          ['channel', 'title'],
        ),
        effect: 'external_write',
        approval: {
          reason: 'Publishing is externally visible.',
          allowedDecisions: ['approve', 'edit', 'reject'],
          projectPublicInput: (input) =>
            input as Record<string, string>,
        },
        execute: publish,
      }],
      toolApprovalHandler: async () => ({
        decision: 'edit',
        editedInput: { channel: 'approved' },
      }),
    });

    const result = await engine.run({
      runId: 'pi-invalid-approval-edit',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_APPROVAL_FAILED' },
    });
    expect(publish).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toContain(
      'tool_approval_requested',
    );
    expect(events.map((event) => event.type)).not.toContain(
      'tool_approval_resolved',
    );
    expect(events.map((event) => event.type)).not.toContain('tool_started');
  });

  it('executes the schema-validated approved edit instead of the original args', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-publish',
        name: 'publish_report',
        arguments: '{"channel":"draft","title":"Initial"}',
      }]),
    ]);
    const publish = vi.fn(async (input: unknown) => ({
      ok: true as const,
      data: input,
    }));
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      maxTurns: 1,
      tools: [{
        name: 'publish_report',
        description: 'Publish a report.',
        inputSchema: objectSchema(
          {
            channel: { type: 'string' },
            title: { type: 'string' },
          },
          ['channel', 'title'],
        ),
        effect: 'external_write',
        approval: {
          reason: 'Publishing is externally visible.',
          allowedDecisions: ['approve', 'edit', 'reject'],
          projectPublicInput: (input) =>
            input as Record<string, string>,
        },
        execute: publish,
      }],
      toolApprovalHandler: async () => ({
        decision: 'edit',
        resolvedBy: 'reviewer-1',
        editedInput: {
          channel: 'approved',
          title: 'Reviewed',
        },
      }),
    });

    const result = await engine.run({
      runId: 'pi-valid-approval-edit',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'max_turns',
      error: { code: 'MAX_TURNS' },
    });
    expect(publish).toHaveBeenCalledWith(
      { channel: 'approved', title: 'Reviewed' },
      expect.any(Object),
    );
    const started = events.find(
      (event) => event.type === 'tool_started',
    );
    expect(started?.type === 'tool_started'
      ? JSON.parse(started.toolCall.arguments)
      : null).toEqual({
      channel: 'approved',
      title: 'Reviewed',
    });
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.indexOf('tool_approval_resolved')).toBeLessThan(
      eventTypes.indexOf('tool_started'),
    );
  });

  it('persists tool_started before allowing the side effect', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-write',
        name: 'write_file',
        arguments: '{"path":"app/page.tsx"}',
      }]),
    ]);
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [{
        name: 'write_file',
        description: 'Write a file.',
        inputSchema: objectSchema(
          { path: { type: 'string' } },
          ['path'],
        ),
        effect: 'workspace_write',
        execute,
      }],
    });

    const result = await engine.run({
      runId: 'pi-start-ledger-failure',
      messages: initialMessages,
    }, {
      durableSink: (event) => {
        if (event.type === 'tool_started') {
          throw new Error('tool ledger unavailable');
        }
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_PIPELINE_FAILED' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops sequential siblings when a mutating outcome cannot be persisted', async () => {
    const first = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'first.ts' },
    }));
    const second = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'second.ts' },
    }));
    const provider = new ScriptedProvider([
      toolTurn([
        {
          id: 'call-first',
          name: 'write_first',
          arguments: '{}',
        },
        {
          id: 'call-second',
          name: 'write_second',
          arguments: '{}',
        },
      ]),
    ]);
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [
        {
          name: 'write_first',
          description: 'First write.',
          inputSchema: objectSchema(),
          effect: 'workspace_write',
          execute: first,
        },
        {
          name: 'write_second',
          description: 'Second write.',
          inputSchema: objectSchema(),
          effect: 'workspace_write',
          execute: second,
        },
      ],
    });

    const result = await engine.run({
      runId: 'pi-outcome-ledger-failure',
      messages: initialMessages,
    }, {
      durableSink: (event) => {
        events.push(event);
        if (
          event.type === 'tool_completed' &&
          event.toolCall.name === 'write_first'
        ) {
          throw new Error('outcome ledger unavailable');
        }
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MUTATION_RECONCILIATION_REQUIRED' },
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCall: expect.objectContaining({ name: 'write_second' }),
    }));
  });

  it('stops sequential siblings after an uncertain mutating result', async () => {
    const first = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'REMOTE_WRITE_TIMEOUT',
        message: 'The remote write may have committed.',
      },
    }));
    const second = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const provider = new ScriptedProvider([
      toolTurn([
        {
          id: 'call-first',
          name: 'external_first',
          arguments: '{}',
        },
        {
          id: 'call-second',
          name: 'external_second',
          arguments: '{}',
        },
      ]),
    ]);
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [
        {
          name: 'external_first',
          description: 'First external write.',
          inputSchema: objectSchema(),
          effect: 'external_write',
          execute: first,
        },
        {
          name: 'external_second',
          description: 'Second external write.',
          inputSchema: objectSchema(),
          effect: 'external_write',
          execute: second,
        },
      ],
    });

    const result = await engine.run({
      runId: 'pi-uncertain-mutation',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MUTATION_RECONCILIATION_REQUIRED' },
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      toolCall: expect.objectContaining({ name: 'external_first' }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCall: expect.objectContaining({ name: 'external_second' }),
    }));
  });

  it('rejects a mixed terminal batch before any side effect starts', async () => {
    const write = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const submit = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const provider = new ScriptedProvider([
      toolTurn([
        {
          id: 'call-write',
          name: 'write_file',
          arguments: '{}',
        },
        {
          id: 'call-submit',
          name: 'submit_result',
          arguments: '{"artifact":"app/page.tsx"}',
        },
      ]),
    ]);
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          inputSchema: objectSchema(),
          effect: 'workspace_write',
          execute: write,
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({
      runId: 'pi-terminal-exclusive',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TERMINAL_TOOL_NOT_EXCLUSIVE' },
    });
    expect(write).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).not.toContain('tool_started');
  });

  it('preflights duplicate IDs and tool budgets before any tool starts', async () => {
    const scenarios = [
      {
        runId: 'pi-duplicate-tool-call',
        expectedCode: 'DUPLICATE_TOOL_CALL_ID',
        options: {},
        calls: [
          { id: 'duplicate', name: 'lookup', arguments: '{}' },
          { id: 'duplicate', name: 'lookup', arguments: '{}' },
        ],
      },
      {
        runId: 'pi-turn-tool-budget',
        expectedCode: 'MAX_TOOL_CALLS_PER_TURN',
        options: { maxToolCallsPerTurn: 1 },
        calls: [
          { id: 'first', name: 'lookup', arguments: '{}' },
          { id: 'second', name: 'lookup', arguments: '{}' },
        ],
      },
      {
        runId: 'pi-argument-budget',
        expectedCode: 'MAX_TOOL_ARGUMENT_CHARS',
        options: { maxToolArgumentChars: 5 },
        calls: [{
          id: 'oversized',
          name: 'lookup',
          arguments: '{"value":"too-long"}',
        }],
      },
    ] as const;

    for (const scenario of scenarios) {
      const execute = vi.fn(async () => ({
        ok: true as const,
        data: {},
      }));
      const provider = new ScriptedProvider([toolTurn([...scenario.calls])]);
      const events: PiAgentEvent[] = [];
      const engine = new PiAgentRunEngine({
        provider,
        model: 'test-model',
        requireTerminalTool: false,
        tools: [{
          name: 'lookup',
          description: 'Read a governed value.',
          inputSchema: objectSchema(),
          effect: 'read',
          execute,
        }],
        ...scenario.options,
      });

      const result = await engine.run({
        runId: scenario.runId,
        messages: initialMessages,
      }, (event) => {
        events.push(event);
      });

      expect(result).toMatchObject({
        status: 'failed',
        error: { code: scenario.expectedCode },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).not.toContain('tool_started');
    }
  });

  it('rejects unsafe provider tool-call IDs before any side effect starts', async () => {
    const write = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'unsafe\ncall',
        name: 'write_file',
        arguments: '{}',
      }]),
    ]);
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [{
        name: 'write_file',
        description: 'Write a file.',
        inputSchema: objectSchema(),
        effect: 'workspace_write',
        execute: write,
      }],
    });

    const result = await engine.run({
      runId: 'pi-invalid-tool-call-id',
      messages: initialMessages,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_TOOL_CALL_ID' },
    });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('PI usage mapping', () => {
  it('maps cache reads and writes without undercounting full input', () => {
    const piUsage = {
      input: 6,
      output: 3,
      cacheRead: 4,
      cacheWrite: 2,
      reasoning: 1,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };

    expect(usageFromPi(piUsage)).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cachedInputTokens: 4,
      cacheMissInputTokens: 8,
      reasoningTokens: 1,
    });

    const hostUsage: PiAgentTokenUsage = {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cachedInputTokens: 4,
      cacheMissInputTokens: 8,
      reasoningTokens: 1,
    };
    expect(usageToPi(hostUsage)).toMatchObject({
      input: 8,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 15,
      reasoning: 1,
    });
  });
});
