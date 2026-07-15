import { describe, expect, it, vi } from 'vitest';
import type {
  MoAgentEvent,
  MoAgentMessage,
  MoAgentModelEvent,
  MoAgentModelProvider,
  MoAgentModelRequest,
  MoAgentTool,
} from '../types';
import { MoAgentContextManager } from '../context';
import { createMoAgentOperationId } from './operation-id';
import { MoAgentRunEngine } from './run-engine';

type Script = readonly MoAgentModelEvent[] | Error;

class ScriptedProvider implements MoAgentModelProvider {
  readonly name = 'scripted';
  readonly requests: MoAgentModelRequest[] = [];
  private readonly scripts: Script[];

  constructor(scripts: Script[]) {
    this.scripts = [...scripts];
  }

  complete(request: MoAgentModelRequest): AsyncIterable<MoAgentModelEvent> {
    this.requests.push({
      ...request,
      messages: request.messages.map((message) => JSON.parse(JSON.stringify(message))),
      tools: request.tools?.map((tool) => ({ ...tool })),
    });
    const script = this.scripts.shift();
    return {
      async *[Symbol.asyncIterator]() {
        if (!script) {
          throw new Error('No scripted model response remains.');
        }
        if (script instanceof Error) {
          throw script;
        }
        for (const event of script) {
          yield event;
        }
      },
    };
  }
}

function usage(inputTokens: number, outputTokens: number): MoAgentModelEvent {
  return {
    type: 'usage',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

function toolTurn(options: {
  name: string;
  arguments: string[];
  id?: string;
  text?: string;
  reasoning?: string;
  usage?: MoAgentModelEvent;
}): MoAgentModelEvent[] {
  return [
    { type: 'response_start', responseId: `response-${options.name}`, model: 'test-model' },
    ...(options.reasoning
      ? ([{ type: 'reasoning_delta', delta: options.reasoning }] as MoAgentModelEvent[])
      : []),
    ...(options.text
      ? ([{ type: 'text_delta', delta: options.text }] as MoAgentModelEvent[])
      : []),
    ...options.arguments.map(
      (argument, index): MoAgentModelEvent => ({
        type: 'tool_call_delta',
        index: 0,
        ...(index === 0
          ? { id: options.id ?? `call-${options.name}`, nameDelta: options.name }
          : {}),
        argumentsDelta: argument,
      })
    ),
    ...(options.usage ? [options.usage] : []),
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ];
}

function terminalTool(
  execute = vi.fn(async (input: unknown) => ({ ok: true as const, data: input }))
): MoAgentTool {
  return {
    name: 'submit_result',
    description: 'Submit the final artifact',
    inputSchema: { type: 'object' },
    terminal: true,
    execute,
  };
}

const initialMessages: MoAgentMessage[] = [{ role: 'user', content: 'Create a dashboard' }];

describe('MoAgentRunEngine', () => {
  it('runs multiple model/tool turns and only completes after a terminal tool succeeds', async () => {
    const provider = new ScriptedProvider([
      toolTurn({
        name: 'lookup',
        arguments: ['{"sym', 'bol":"600519.SH"}'],
        text: 'Checking.',
        reasoning: 'Need evidence.',
        usage: usage(10, 3),
      }),
      toolTurn({
        name: 'submit_result',
        arguments: ['{"artifact":"app/page.tsx"}'],
        text: 'Done.',
        reasoning: 'Artifact is ready.',
        usage: usage(20, 4),
      }),
    ]);
    const lookup = vi.fn(async (input: unknown) => ({
      ok: true as const,
      data: { input, price: 1_500 },
    }));
    const submit = vi.fn(async (input: unknown) => ({
      ok: true as const,
      data: input,
      content: 'accepted',
    }));
    const tools: MoAgentTool[] = [
      {
        name: 'lookup',
        description: 'Look up evidence',
        inputSchema: { type: 'object' },
        execute: lookup,
      },
      terminalTool(submit),
    ];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools,
      idFactory: () => 'run-multi-turn',
    });
    const events: MoAgentEvent[] = [];

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      runId: 'run-multi-turn',
      status: 'completed',
      turns: 2,
      output: 'Checking.Done.',
      usage: { inputTokens: 30, outputTokens: 7, totalTokens: 37 },
      terminalToolCall: { name: 'submit_result' },
      terminalResult: { ok: true, data: { artifact: 'app/page.tsx' } },
    });
    expect(lookup).toHaveBeenCalledWith(
      { symbol: '600519.SH' },
      expect.objectContaining({ runId: 'run-multi-turn', turn: 1, toolCallId: 'call-lookup' })
    );
    expect(submit).toHaveBeenCalledOnce();
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].messages).toContainEqual({
      role: 'assistant',
      content: 'Checking.',
      reasoningContent: 'Need evidence.',
      toolCalls: [
        {
          id: 'call-lookup',
          name: 'lookup',
          arguments: '{"symbol":"600519.SH"}',
        },
      ],
    });
    const toolMessage = provider.requests[1].messages.find((message) => message.role === 'tool');
    expect(toolMessage?.role === 'tool' ? JSON.parse(toolMessage.content) : null).toEqual({
      ok: true,
      data: { input: { symbol: '600519.SH' }, price: 1_500 },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'run_started',
        'tool_call_delta',
        'tool_started',
        'tool_completed',
        'run_finished',
      ])
    );
    expect(events.map((event) => event.type)).not.toContain('reasoning_delta');
    const assistantEvents = events.filter((event) => event.type === 'assistant_message');
    expect(assistantEvents).toHaveLength(2);
    expect(assistantEvents[0]).toMatchObject({
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [{ id: 'call-lookup', name: 'lookup' }],
      },
    });
    expect(assistantEvents[0]).not.toHaveProperty('message.reasoningContent');
    expect(assistantEvents[1]).not.toHaveProperty('message.reasoningContent');
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      result: { status: 'completed' },
    });
    expect(events.at(-1)).not.toHaveProperty('result.messages');
    expect(events.at(-1)).not.toHaveProperty('result.output');
    expect(events.at(-1)).not.toHaveProperty('result.terminalResult');
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1)
    );
    expect(events.map((event) => event.eventId)).toEqual(
      events.map((_, index) => `run-multi-turn:${index + 1}`)
    );
  });

  it('maps provider retry events into the run event stream', async () => {
    const provider = new ScriptedProvider([[
      {
        type: 'provider_retry',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 250,
        code: 'HTTP_ERROR',
        status: 429,
      },
      ...toolTurn({ name: 'submit_result', arguments: ['{}'] }),
    ]]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [terminalTool()],
      idFactory: () => 'run-provider-retry',
    });
    const events: MoAgentEvent[] = [];

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result.status).toBe('completed');
    expect(events.find((event) => event.type === 'provider_retry')).toMatchObject({
      type: 'provider_retry',
      runId: 'run-provider-retry',
      turn: 1,
      attempt: 2,
      maxAttempts: 3,
      delayMs: 250,
      code: 'HTTP_ERROR',
      status: 429,
    });
  });

  it('feeds malformed JSON and tool execution errors back to the model', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{"broken"'] }),
      toolTurn({ name: 'explode', arguments: ['{}'] }),
      toolTurn({ name: 'submit_result', arguments: ['{}'] }),
    ]);
    const lookup = vi.fn(async () => ({ ok: true as const, data: 'not reached' }));
    const explode = vi.fn(async () => {
      throw new Error('workspace unavailable');
    });
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          inputSchema: { type: 'object' },
          execute: lookup,
        },
        {
          name: 'explode',
          description: 'Fail',
          inputSchema: { type: 'object' },
          effect: 'read',
          idempotency: 'intrinsic',
          execute: explode,
        },
        terminalTool(),
      ],
    });
    const events: MoAgentEvent[] = [];

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result.status).toBe('completed');
    expect(lookup).not.toHaveBeenCalled();
    const secondRequestToolMessage = provider.requests[1].messages.find(
      (message) => message.role === 'tool'
    );
    expect(
      secondRequestToolMessage?.role === 'tool'
        ? JSON.parse(secondRequestToolMessage.content)
        : null
    ).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_ARGUMENTS' } });
    const thirdRequestToolMessages = provider.requests[2].messages.filter(
      (message) => message.role === 'tool'
    );
    expect(
      thirdRequestToolMessages[1]?.role === 'tool'
        ? JSON.parse(thirdRequestToolMessages[1].content)
        : null
    ).toEqual({
      ok: false,
      error: { code: 'TOOL_EXECUTION_FAILED', message: 'workspace unavailable' },
    });
    expect(events.filter((event) => event.type === 'tool_failed')).toHaveLength(2);
  });

  it('fails closed before another provider turn when a mutation outcome is uncertain', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'write_file', arguments: ['{}'] }),
      toolTurn({ name: 'submit_result', arguments: ['{}'] }),
    ]);
    const write = vi.fn(async () => {
      throw new Error('rename acknowledgement was lost');
    });
    const events: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [{
        name: 'write_file',
        description: 'Mutate the workspace',
        inputSchema: { type: 'object' },
        effect: 'workspace_write',
        idempotency: 'reconcile_required',
        execute: write,
      }, terminalTool()],
    });

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MUTATION_RECONCILIATION_REQUIRED' },
    });
    expect(provider.requests).toHaveLength(1);
    expect(write).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'tool_failed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      result: {
        status: 'failed',
        error: { code: 'MUTATION_RECONCILIATION_REQUIRED' },
      },
    });
  });

  it('continues after a workspace mutation is provably rejected before commit', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'edit_file', arguments: ['{}'], usage: usage(3, 1) }),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(3, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [{
        name: 'edit_file',
        description: 'Edit one unique match',
        inputSchema: { type: 'object' },
        effect: 'workspace_write',
        idempotency: 'reconcile_required',
        execute: async () => ({
          ok: false,
          error: { code: 'EDIT_MATCH_NOT_FOUND', message: 'oldText was not found' },
        }),
      }, terminalTool()],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result.status).toBe('completed');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      name: 'edit_file',
    });
  });

  it('injects and records a high-priority convergence prompt after a write-read loop', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'write_file', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'read_file_range', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'read_file_range', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'read_file_range', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(5, 1) }),
    ]);
    const events: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 12,
      tools: [
        {
          name: 'write_file',
          description: 'Write a workspace file',
          inputSchema: {},
          effect: 'workspace_write',
          execute: async () => ({ ok: true, data: { path: 'app/page.tsx' } }),
        },
        {
          name: 'read_file_range',
          description: 'Read a file range',
          inputSchema: {},
          effect: 'read',
          execute: async () => ({ ok: true, data: 'source' }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result.status).toBe('completed');
    expect(provider.requests).toHaveLength(5);
    for (const request of provider.requests.slice(0, 4)) {
      expect(request.messages.some(
        (message) => (message.content ?? '').includes('Runtime Convergence Directive')
      )).toBe(false);
    }
    const directive = provider.requests[4].messages.find(
      (message) => message.role === 'user' &&
        message.content.includes('Runtime Convergence Directive')
    );
    expect(directive).toMatchObject({ role: 'user' });
    expect(directive?.content).toContain('does not mark the run successful');
    expect(directive?.content).toContain('File existence and successful writes alone are not validation');
    expect(events.filter((event) => event.type === 'convergence_prompt')).toEqual([
      expect.objectContaining({
        type: 'convergence_prompt',
        turn: 5,
        reasons: ['post_write_read_loop'],
        remainingTurns: 8,
        successfulWorkspaceWrites: 1,
        consecutiveReadOnlyTurns: 3,
      }),
    ]);
  });

  it('stops broad exploration before the first write consumes the run budget', async () => {
    const readTurn = () => toolTurn({
      name: 'read_file_range',
      arguments: ['{}'],
      usage: usage(5, 1),
    });
    const provider = new ScriptedProvider([
      readTurn(), readTurn(), readTurn(), readTurn(), readTurn(), readTurn(),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(5, 1) }),
    ]);
    const events: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 12,
      tools: [
        {
          name: 'read_file_range',
          description: 'Read a file range',
          inputSchema: {},
          effect: 'read',
          execute: async () => ({ ok: true, data: 'source' }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({ status: 'completed', turns: 7 });
    for (const request of provider.requests.slice(0, 6)) {
      expect(request.messages.some(
        (message) => (message.content ?? '').includes('Runtime Convergence Directive')
      )).toBe(false);
    }
    expect(provider.requests[6].messages.some(
      (message) => message.role === 'user' &&
        message.content.includes('without a workspace write')
    )).toBe(true);
    expect(provider.requests[6].tools?.map((tool) => tool.name)).toContain(
      'read_file_range'
    );
    expect(events.find((event) => event.type === 'convergence_prompt')).toMatchObject({
      type: 'convergence_prompt',
      turn: 7,
      reasons: ['exploration_read_loop'],
      remainingTurns: 6,
      remainingToolCalls: 58,
      successfulWorkspaceWrites: 0,
      consecutiveReadOnlyTurns: 6,
    });
  });

  it('supports a tighter product-level pre-write exploration threshold', async () => {
    const readTurn = () => toolTurn({
      name: 'read_file_range',
      arguments: ['{}'],
      usage: usage(5, 1),
    });
    const provider = new ScriptedProvider([
      readTurn(), readTurn(), readTurn(),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(5, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 12,
      preWriteReadOnlyTurnThreshold: 3,
      tools: [
        {
          name: 'read_file_range',
          description: 'Read a file range',
          inputSchema: {},
          effect: 'read',
          execute: async () => ({ ok: true, data: 'source' }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({ status: 'completed', turns: 4 });
    expect(provider.requests.slice(0, 3).every((request) =>
      request.messages.every((message) =>
        !(message.content ?? '').includes('Runtime Convergence Directive')
      )
    )).toBe(true);
    expect(provider.requests[3].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('3 consecutive read-only turns'),
    });
    expect(provider.requests[3].messages.at(-1)).toMatchObject({
      content: expect.stringContaining('read-only tools are unavailable'),
    });
    expect(provider.requests[3].tools?.map((tool) => tool.name)).toEqual([
      'submit_result',
    ]);
  });

  it('reuses identical workspace observations and immediately converges until a write changes the generation', async () => {
    const provider = new ScriptedProvider([
      toolTurn({
        name: 'query_text_file',
        id: 'call-read-1',
        arguments: ['{"path":"app/page.tsx","anchors":["Root"]}'],
      }),
      toolTurn({
        name: 'query_text_file',
        id: 'call-read-2',
        // Key order differs deliberately; the observation key is canonical.
        arguments: ['{"anchors":["Root"],"path":"app/page.tsx"}'],
      }),
      toolTurn({
        name: 'edit_file',
        id: 'call-write',
        arguments: ['{"path":"app/page.tsx"}'],
      }),
      toolTurn({
        name: 'query_text_file',
        id: 'call-read-3',
        arguments: ['{"path":"app/page.tsx","anchors":["Root"]}'],
      }),
      toolTurn({
        name: 'submit_result',
        id: 'call-submit',
        arguments: ['{}'],
      }),
    ]);
    const read = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx' },
      content: 'bounded source observation',
    }));
    const write = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx', afterSha256: 'changed' },
    }));
    const events: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [
        {
          name: 'query_text_file',
          description: 'Read anchored source',
          inputSchema: { type: 'object' },
          effect: 'read',
          idempotency: 'intrinsic',
          observationCache: 'workspace_generation',
          execute: read,
        },
        {
          name: 'edit_file',
          description: 'Edit source',
          inputSchema: { type: 'object' },
          effect: 'workspace_write',
          idempotency: 'reconcile_required',
          execute: write,
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result.status).toBe('completed');
    // The duplicate was not executed; the post-write read belongs to a new
    // workspace generation and therefore executes normally.
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect(provider.requests[2].tools?.map((tool) => tool.name)).toEqual(['edit_file']);
    expect(events.find((event) =>
      event.type === 'convergence_prompt' &&
      event.reasons.includes('repeated_read_observation')
    )).toMatchObject({
      type: 'convergence_prompt',
      turn: 3,
      reasons: ['repeated_read_observation'],
    });
    const promptEvents = events.filter(
      (event): event is Extract<MoAgentEvent, { type: 'prompt_prepared' }> =>
        event.type === 'prompt_prepared'
    );
    expect(promptEvents).toHaveLength(5);
    expect(promptEvents.map((event) => ({
      turn: event.turn,
      change: event.change,
      toolSetChanged: event.toolSetChanged,
      requestLocalControlSuffix: event.requestLocalControlSuffix,
    }))).toEqual([
      { turn: 1, change: 'first_request', toolSetChanged: false, requestLocalControlSuffix: false },
      { turn: 2, change: 'append_only', toolSetChanged: false, requestLocalControlSuffix: false },
      { turn: 3, change: 'append_only', toolSetChanged: true, requestLocalControlSuffix: true },
      { turn: 4, change: 'request_local_suffix_rotated', toolSetChanged: true, requestLocalControlSuffix: false },
      { turn: 5, change: 'append_only', toolSetChanged: false, requestLocalControlSuffix: false },
    ]);
    expect(promptEvents.every((event) =>
      /^[a-f0-9]{64}$/.test(event.systemSha256) &&
      /^[a-f0-9]{64}$/.test(event.messagesSha256) &&
      /^[a-f0-9]{64}$/.test(event.toolsSha256)
    )).toBe(true);
    const reused = result.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'call-read-2'
    );
    expect(reused?.role).toBe('tool');
    if (!reused || reused.role !== 'tool') throw new Error('Expected reused read result');
    expect(JSON.parse(reused.content)).toMatchObject({
      ok: true,
      data: {
        $moagent: {
          kind: 'reused_read_observation',
          originalToolCallId: 'call-read-1',
          workspaceChangedSinceOriginal: false,
        },
      },
    });
  });

  it('never caches live reads without an explicit workspace observation policy', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'quant_api_get', id: 'live-1', arguments: ['{"symbol":"600519"}'] }),
      toolTurn({ name: 'quant_api_get', id: 'live-2', arguments: ['{"symbol":"600519"}'] }),
    ]);
    const liveRead = vi.fn(async () => ({ ok: true as const, data: { price: 1 } }));
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 2,
      tools: [{
        name: 'quant_api_get',
        description: 'Read live market data',
        inputSchema: { type: 'object' },
        effect: 'read',
        idempotency: 'intrinsic',
        execute: liveRead,
      }],
    });

    await engine.run({ messages: initialMessages });

    expect(liveRead).toHaveBeenCalledTimes(2);
  });

  it('hard-gates read tools at explicit pre-write and post-write thresholds', async () => {
    const readTurn = () => toolTurn({
      name: 'query_json',
      arguments: ['{}'],
      usage: usage(5, 1),
    });
    const provider = new ScriptedProvider([
      readTurn(), readTurn(), readTurn(),
      toolTurn({ name: 'edit_file', arguments: ['{}'], usage: usage(5, 1) }),
      readTurn(), readTurn(),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(5, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 12,
      preWriteReadOnlyTurnThreshold: 3,
      postWriteReadOnlyTurnThreshold: 2,
      tools: [
        {
          name: 'query_json',
          description: 'Read structured data',
          inputSchema: {},
          effect: 'read',
          execute: async () => ({ ok: true, data: 'source' }),
        },
        {
          name: 'edit_file',
          description: 'Edit the workspace',
          inputSchema: {},
          effect: 'workspace_write',
          execute: async () => ({ ok: true, data: { path: 'app/page.tsx' } }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({ status: 'completed', turns: 7 });
    expect(provider.requests.slice(0, 3).every((request) =>
      request.tools?.some((tool) => tool.name === 'query_json')
    )).toBe(true);
    expect(provider.requests[3].tools?.map((tool) => tool.name)).toEqual([
      'edit_file',
      'submit_result',
    ]);
    expect(provider.requests.slice(4, 6).every((request) =>
      request.tools?.some((tool) => tool.name === 'query_json')
    )).toBe(true);
    expect(provider.requests[6].tools?.map((tool) => tool.name)).toEqual([
      'edit_file',
      'submit_result',
    ]);
  });

  it('returns a bounded policy error for hidden reads and stops repeated violations', async () => {
    const read = vi.fn(async () => ({ ok: true as const, data: 'source' }));
    const provider = new ScriptedProvider([
      toolTurn({ name: 'query_json', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'query_json', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'query_json', arguments: ['{}'], usage: usage(5, 1) }),
    ]);
    const events: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 10,
      preWriteReadOnlyTurnThreshold: 1,
      tools: [
        {
          name: 'query_json',
          description: 'Read structured data',
          inputSchema: {},
          effect: 'read',
          execute: read,
        },
        {
          name: 'edit_file',
          description: 'Edit the workspace',
          inputSchema: {},
          effect: 'workspace_write',
          execute: async () => ({ ok: true, data: { path: 'app/page.tsx' } }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      turns: 3,
      error: { code: 'CONVERGENCE_TOOL_POLICY_VIOLATION' },
    });
    expect(provider.requests).toHaveLength(3);
    expect(read).toHaveBeenCalledOnce();
    expect(provider.requests.slice(1).every((request) =>
      request.tools?.every((tool) => tool.name !== 'query_json')
    )).toBe(true);
    expect(JSON.stringify(provider.requests[2].messages)).toContain(
      'TOOL_DISABLED_BY_CONVERGENCE'
    );
    expect(events.filter((event) =>
      event.type === 'tool_failed' &&
      event.result.error.code === 'TOOL_DISABLED_BY_CONVERGENCE'
    )).toHaveLength(2);
  });

  it('keeps the system prefix stable while injecting one ephemeral user directive per active turn', async () => {
    const convergenceDirectivePrefix =
      '[MoAgent Runtime Convergence Directive - HIGH PRIORITY]';
    const readTurn = () => toolTurn({
      name: 'read_file_range',
      arguments: ['{}'],
      usage: usage(5, 1),
    });
    const provider = new ScriptedProvider([
      readTurn(), readTurn(), readTurn(), readTurn(), readTurn(), readTurn(),
      readTurn(), readTurn(),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(5, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 20,
      tools: [
        {
          name: 'read_file_range',
          description: 'Read a file range',
          inputSchema: {},
          effect: 'read',
          execute: async () => ({ ok: true, data: 'source' }),
        },
        terminalTool(),
      ],
    });
    const trustedSystemMessage: MoAgentMessage = {
      role: 'system',
      content: 'Immutable trusted policy',
    };

    const result = await engine.run({
      messages: [trustedSystemMessage, ...initialMessages],
    });

    expect(result).toMatchObject({ status: 'completed', turns: 9 });
    for (const request of provider.requests.slice(0, 6)) {
      expect(request.messages.some(
        (message) => (message.content ?? '').startsWith(convergenceDirectivePrefix)
      )).toBe(false);
    }
    for (const request of provider.requests.slice(6)) {
      const directives = request.messages.filter(
        (message) => message.role === 'user' &&
          message.content.startsWith(convergenceDirectivePrefix)
      );
      expect(directives).toHaveLength(1);
      expect(request.messages.at(-1)).toEqual(directives[0]);

      const leadingSystemMessages = request.messages
        .slice(0, request.messages.findIndex((message) => message.role !== 'system'));
      expect(leadingSystemMessages).toEqual([trustedSystemMessage]);
    }
    const firstConvergedCanonicalPrefix = provider.requests[6].messages.slice(0, -1);
    for (const request of provider.requests.slice(7)) {
      expect(
        request.messages.slice(0, firstConvergedCanonicalPrefix.length)
      ).toEqual(firstConvergedCanonicalPrefix);
    }
    expect(result.messages.some(
      (message) => (message.content ?? '').startsWith(convergenceDirectivePrefix)
    )).toBe(false);
  });

  it('starts turn-limit convergence with repair space still available', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'read_file_range', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'read_file_range', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'read_file_range', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'write_file', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'read_file_range', arguments: ['{}'], usage: usage(5, 1) }),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(5, 1) }),
    ]);
    const events: MoAgentEvent[] = [];
    const submit = vi.fn(async () => ({ ok: true as const, data: { accepted: true } }));
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 6,
      tools: [
        {
          name: 'read_file_range',
          description: 'Read a file range',
          inputSchema: {},
          effect: 'read',
          execute: async () => ({ ok: true, data: 'source' }),
        },
        {
          name: 'write_file',
          description: 'Repair a workspace file',
          inputSchema: {},
          effect: 'workspace_write',
          execute: async () => ({ ok: true, data: { path: 'app/page.tsx' } }),
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({ status: 'completed', turns: 6 });
    expect(submit).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === 'convergence_prompt')).toMatchObject({
      type: 'convergence_prompt',
      turn: 3,
      reasons: ['turn_limit'],
      remainingTurns: 4,
    });
    expect(events.filter(
      (event) => event.type === 'tool_started' && event.toolCall.name === 'write_file'
    )[0]).toMatchObject({ turn: 4 });
    expect(events.filter(
      (event) => event.type === 'tool_started' && event.toolCall.name === 'submit_result'
    )[0]).toMatchObject({ turn: 6 });
    const initialDirective = provider.requests[2].messages.find(
      (message) => message.role === 'user' &&
        message.content.includes('Runtime Convergence Directive')
    );
    expect(initialDirective?.content).toContain(
      'Reserve at least one turn for a concrete repair'
    );
  });

  it('does not treat a convergence prompt or successful write as completion', async () => {
    const submit = vi.fn(async () => ({ ok: true as const, data: {} }));
    const engine = new MoAgentRunEngine({
      provider: new ScriptedProvider([
        toolTurn({ name: 'write_file', arguments: ['{}'], usage: usage(5, 1) }),
      ]),
      model: 'test-model',
      maxTurns: 1,
      tools: [
        {
          name: 'write_file',
          description: 'Write a workspace file',
          inputSchema: {},
          effect: 'workspace_write',
          execute: async () => ({ ok: true, data: { path: 'app/page.tsx' } }),
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'max_turns',
      turns: 1,
      error: { code: 'MAX_TURNS' },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('enforces the cumulative output-token budget before another model turn', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'], usage: usage(9, 5) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTokens: 5,
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          inputSchema: { type: 'object' },
          execute: async () => ({ ok: true, data: 'done' }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'max_tokens',
      turns: 1,
      error: { code: 'MAX_TOKENS' },
      usage: { outputTokens: 5 },
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].maxTokens).toBe(5);
  });

  it('stops before another provider request after the cumulative input budget is consumed', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'], usage: usage(11, 1) }),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(1, 1) }),
    ]);
    const lookup = vi.fn(async () => ({ ok: true as const, data: 'done' }));
    const submit = vi.fn(async () => ({ ok: true as const, data: 'accepted' }));
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxRunInputTokens: 10,
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          inputSchema: { type: 'object' },
          effect: 'read',
          execute: lookup,
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'max_tokens',
      turns: 1,
      usage: { inputTokens: 11 },
      error: { code: 'MAX_RUN_INPUT_TOKENS' },
    });
    expect(provider.requests).toHaveLength(1);
    expect(lookup).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps a successful terminal result from the request that crosses an input budget', async () => {
    const submit = vi.fn(async () => ({ ok: true as const, data: 'accepted' }));
    const provider = new ScriptedProvider([
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(11, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxRunInputTokens: 10,
      tools: [terminalTool(submit)],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'completed',
      turns: 1,
      usage: { inputTokens: 11 },
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(provider.requests).toHaveLength(1);
  });

  it('uses only provider-reported cache misses for the cumulative cache-miss budget', async () => {
    const cacheUsage: MoAgentModelEvent = {
      type: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 1,
        totalTokens: 101,
        cachedInputTokens: 95,
        cacheMissInputTokens: 5,
      },
    };
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'], usage: cacheUsage }),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(1, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxRunCacheMissInputTokens: 5,
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          inputSchema: { type: 'object' },
          effect: 'read',
          execute: async () => ({ ok: true, data: 'done' }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'max_tokens',
      turns: 1,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 95,
        cacheMissInputTokens: 5,
      },
      error: { code: 'MAX_RUN_CACHE_MISS_INPUT_TOKENS' },
    });
    expect(provider.requests).toHaveLength(1);
  });

  it('does not infer cache misses when a provider omits the cache usage breakdown', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'], usage: usage(100, 1) }),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(100, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxRunCacheMissInputTokens: 1,
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          inputSchema: { type: 'object' },
          effect: 'read',
          execute: async () => ({ ok: true, data: 'done' }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result.status).toBe('completed');
    expect(result.usage.cacheMissInputTokens).toBeUndefined();
    expect(provider.requests).toHaveLength(2);
  });

  it('separates the per-turn provider cap from the cumulative run budget', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'], usage: usage(5, 2) }),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(5, 2) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTokens: 40,
      maxTokensPerTurn: 7,
      tools: [{
        name: 'lookup',
        description: 'Lookup',
        inputSchema: {},
        execute: async () => ({ ok: true, data: 'done' }),
      }, terminalTool()],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result.status).toBe('completed');
    expect(provider.requests.map((request) => request.maxTokens)).toEqual([7, 7]);
  });

  it('omits toolChoice while reasoning mode is enabled', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(2, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [terminalTool()],
    });

    const result = await engine.run({
      messages: initialMessages,
      reasoning: { enabled: true, effort: 'max' },
    });

    expect(result.status).toBe('completed');
    expect(provider.requests[0].toolChoice).toBeUndefined();
  });

  it('conservatively charges missing usage and reduces the next turn budget', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'] }),
      toolTurn({ name: 'submit_result', arguments: ['{}'], usage: usage(1, 1) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTokens: 500,
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          inputSchema: { type: 'object' },
          execute: async () => ({ ok: true, data: 'done' }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result.status).toBe('completed');
    expect(result.usage.outputTokens).toBeGreaterThan(1);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].maxTokens).toBeLessThan(500);
    expect(provider.requests[1].maxTokens).toBe(
      500 - (result.usage.outputTokens - 1)
    );
  });

  it('does not execute a tool when conservative usage exhausts the budget', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: 'done' }));
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'] }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTokens: 1,
      tools: [
        { name: 'lookup', description: 'Lookup', inputSchema: {}, execute },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({ status: 'max_tokens', error: { code: 'MAX_TOKENS' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('never executes tool deltas under a non-tool finish reason', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: 'unsafe' }));
    const provider = new ScriptedProvider([[
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-smuggled',
        nameDelta: 'lookup',
        argumentsDelta: '{}',
      },
      usage(1, 1),
      { type: 'finish', reason: 'stop', rawReason: 'stop' },
    ]]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: {}, execute }],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'UNEXPECTED_TOOL_CALLS' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects tool-call smuggling after a finish event', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: 'unsafe' }));
    const provider = new ScriptedProvider([[
      { type: 'finish', reason: 'stop', rawReason: 'stop' },
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-after-finish',
        nameDelta: 'lookup',
        argumentsDelta: '{}',
      },
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
    ]]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: {}, execute }],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('after its finish reason') },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a changed tool-call ID for one index before tool execution', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: 'unsafe' }));
    const provider = new ScriptedProvider([[
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-original',
        nameDelta: 'lookup',
        argumentsDelta: '{',
      },
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-replaced',
        argumentsDelta: '}',
      },
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
    ]]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: {}, execute }],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('changed the tool-call ID for index 0') },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate tool-call IDs across indexes before tool execution', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: 'unsafe' }));
    const provider = new ScriptedProvider([[
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-duplicate',
        nameDelta: 'lookup',
        argumentsDelta: '{}',
      },
      {
        type: 'tool_call_delta',
        index: 1,
        id: 'call-duplicate',
        nameDelta: 'lookup',
        argumentsDelta: '{}',
      },
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
    ]]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: {}, execute }],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('duplicate tool-call ID') },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a terminal tool call to be exclusive before any tool execution', async () => {
    const lookupExecute = vi.fn(async () => ({ ok: true as const, data: 'unsafe' }));
    const submitExecute = vi.fn(async () => ({ ok: true as const, data: 'unsafe' }));
    const provider = new ScriptedProvider([[
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-submit',
        nameDelta: 'submit_result',
        argumentsDelta: '{}',
      },
      {
        type: 'tool_call_delta',
        index: 1,
        id: 'call-lookup',
        nameDelta: 'lookup',
        argumentsDelta: '{}',
      },
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
    ]]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [
        { name: 'lookup', description: 'Lookup', inputSchema: {}, execute: lookupExecute },
        terminalTool(submitExecute),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TERMINAL_TOOL_NOT_EXCLUSIVE' },
    });
    expect(lookupExecute).not.toHaveBeenCalled();
    expect(submitExecute).not.toHaveBeenCalled();
  });

  it('requires a successful workspace write before terminal completion when enabled', async () => {
    const provider = new ScriptedProvider([
      toolTurn({
        name: 'submit_result',
        id: 'call-submit-before-write',
        arguments: ['{}'],
      }),
      toolTurn({
        name: 'edit_file',
        id: 'call-corrective-write',
        arguments: ['{}'],
      }),
      toolTurn({
        name: 'submit_result',
        id: 'call-submit-after-write',
        arguments: ['{}'],
      }),
    ]);
    const edit = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx' },
    }));
    const submit = vi.fn(async () => ({
      ok: true as const,
      data: { accepted: true },
    }));
    const events: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [
        {
          name: 'edit_file',
          description: 'Edit the workspace',
          inputSchema: {},
          effect: 'workspace_write',
          execute: edit,
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'completed',
      turns: 3,
      terminalToolCall: { id: 'call-submit-after-write', name: 'submit_result' },
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(provider.requests[1].tools?.map((tool) => tool.name)).toEqual([
      'edit_file',
    ]);
    expect(provider.requests[2].tools?.map((tool) => tool.name)).toEqual([
      'edit_file',
      'submit_result',
    ]);
    const correctionToolMessage = provider.requests[1].messages.at(-1);
    expect(
      correctionToolMessage?.role === 'tool'
        ? JSON.parse(correctionToolMessage.content)
        : null
    ).toMatchObject({
      ok: false,
      error: {
        code: 'WORKSPACE_WRITE_REQUIRED',
        message: expect.stringContaining('successful workspace_write'),
      },
    });
    expect(events.filter((event) =>
      event.type === 'tool_failed' &&
      event.result.error.code === 'WORKSPACE_WRITE_REQUIRED'
    )).toHaveLength(1);
  });

  it('fails with WORKSPACE_WRITE_REQUIRED after a second terminal attempt without a write', async () => {
    const provider = new ScriptedProvider([
      toolTurn({
        name: 'submit_result',
        id: 'call-submit-before-write',
        arguments: ['{}'],
      }),
      toolTurn({
        name: 'submit_result',
        id: 'call-submit-during-correction',
        arguments: ['{}'],
      }),
    ]);
    const submit = vi.fn(async () => ({
      ok: true as const,
      data: { accepted: true },
    }));
    const events: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [
        {
          name: 'edit_file',
          description: 'Edit the workspace',
          inputSchema: {},
          effect: 'workspace_write',
          execute: async () => ({ ok: true, data: { path: 'app/page.tsx' } }),
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      turns: 2,
      error: { code: 'WORKSPACE_WRITE_REQUIRED' },
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].tools?.map((tool) => tool.name)).toEqual([
      'edit_file',
    ]);
    expect(submit).not.toHaveBeenCalled();
    expect(events.filter((event) =>
      event.type === 'tool_failed' &&
      event.result.error.code === 'WORKSPACE_WRITE_REQUIRED'
    )).toHaveLength(2);
  });

  it('fails with WORKSPACE_WRITE_REQUIRED when the one corrective write is rejected', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'submit_result', arguments: ['{}'] }),
      toolTurn({ name: 'edit_file', arguments: ['{}'] }),
    ]);
    const edit = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'EDIT_MATCH_NOT_FOUND',
        message: 'oldText was not found',
      },
    }));
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [
        {
          name: 'edit_file',
          description: 'Edit one unique match',
          inputSchema: {},
          effect: 'workspace_write',
          idempotency: 'reconcile_required',
          execute: edit,
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'failed',
      turns: 2,
      error: { code: 'WORKSPACE_WRITE_REQUIRED' },
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(provider.requests).toHaveLength(2);
  });

  it('rejects the workspace-write terminal guard without a workspace-write tool', () => {
    expect(() => new MoAgentRunEngine({
      provider: new ScriptedProvider([]),
      model: 'test-model',
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [terminalTool()],
    })).toThrow('requireWorkspaceWriteBeforeTerminal requires a workspace_write tool.');
  });

  it('checks reported usage before any tool side effect', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: 'unsafe' }));
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'], usage: usage(1, 5) }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTokens: 5,
      tools: [
        { name: 'lookup', description: 'Lookup', inputSchema: {}, execute },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result.status).toBe('max_tokens');
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces per-turn and cumulative tool-call limits', async () => {
    const twoCalls: MoAgentModelEvent[] = [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call-1',
        nameDelta: 'lookup',
        argumentsDelta: '{}',
      },
      {
        type: 'tool_call_delta',
        index: 1,
        id: 'call-2',
        nameDelta: 'lookup',
        argumentsDelta: '{}',
      },
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
    ];
    const perTurnExecute = vi.fn(async () => ({ ok: true as const, data: 'done' }));
    const perTurn = new MoAgentRunEngine({
      provider: new ScriptedProvider([twoCalls]),
      model: 'test-model',
      maxToolCallsPerTurn: 1,
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: {}, execute: perTurnExecute }],
    });

    const perTurnResult = await perTurn.run({ messages: initialMessages });
    expect(perTurnResult).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('per-turn limit') },
    });
    expect(perTurnExecute).not.toHaveBeenCalled();

    const cumulativeExecute = vi.fn(async () => ({ ok: true as const, data: 'done' }));
    const cumulative = new MoAgentRunEngine({
      provider: new ScriptedProvider([
        toolTurn({ name: 'lookup', arguments: ['{}'], usage: usage(1, 1) }),
        toolTurn({ name: 'lookup', arguments: ['{}'], usage: usage(1, 1) }),
      ]),
      model: 'test-model',
      maxTotalToolCalls: 1,
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: {}, execute: cumulativeExecute }],
    });

    const cumulativeResult = await cumulative.run({ messages: initialMessages });
    expect(cumulativeResult).toMatchObject({
      status: 'failed',
      error: {
        code: 'MAX_TOTAL_TOOL_CALLS',
        message: expect.stringContaining('tool run limit'),
      },
    });
    expect(cumulativeExecute).toHaveBeenCalledOnce();
  });

  it('enforces provider-neutral text, reasoning, and argument limits', async () => {
    const cases: Array<{
      events: MoAgentModelEvent[];
      options: Partial<ConstructorParameters<typeof MoAgentRunEngine>[0]>;
      message: string;
    }> = [
      {
        events: [
          { type: 'text_delta', delta: '123456' },
          { type: 'finish', reason: 'stop', rawReason: 'stop' },
        ],
        options: { maxTextCharsPerTurn: 5 },
        message: 'text limit',
      },
      {
        events: [
          { type: 'reasoning_delta', delta: '123456' },
          { type: 'finish', reason: 'stop', rawReason: 'stop' },
        ],
        options: { maxReasoningCharsPerTurn: 5 },
        message: 'reasoning limit',
      },
      {
        events: [
          {
            type: 'tool_call_delta',
            index: 0,
            id: 'call',
            nameDelta: 'lookup',
            argumentsDelta: '123456',
          },
          { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
        ],
        options: { maxToolArgumentChars: 5 },
        message: 'tool-argument limit',
      },
    ];

    for (const testCase of cases) {
      const engine = new MoAgentRunEngine({
        provider: new ScriptedProvider([testCase.events]),
        model: 'test-model',
        ...testCase.options,
      });
      const result = await engine.run({ messages: initialMessages });
      expect(result, testCase.message).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining(testCase.message) },
      });
    }
  });

  it('bounds a hanging event consumer by the run deadline', async () => {
    const provider = new ScriptedProvider([[
      { type: 'finish', reason: 'stop', rawReason: 'stop' },
    ]]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      timeoutMs: 5_000,
      eventHandlerTimeoutMs: 10,
    });

    await expect(engine.run(
      { messages: initialMessages },
      () => new Promise<void>(() => undefined)
    )).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('enforces maxTurns after non-terminal tool loops', async () => {
    const provider = new ScriptedProvider([
      toolTurn({ name: 'lookup', arguments: ['{}'] }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      maxTurns: 1,
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          inputSchema: { type: 'object' },
          execute: async () => ({ ok: true, data: 'done' }),
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'max_turns',
      turns: 1,
      error: { code: 'MAX_TURNS' },
    });
  });

  it('requires an explicit terminal call when a terminal tool is registered', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', delta: 'I think it is done.' },
        { type: 'finish', reason: 'stop', rawReason: 'stop' },
      ],
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [terminalTool()],
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'stopped',
      output: 'I think it is done.',
      error: { code: 'TERMINAL_TOOL_REQUIRED' },
    });
  });

  it('hard-stops an uncooperative provider on timeout', async () => {
    const provider: MoAgentModelProvider = {
      name: 'never-ending',
      complete: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<MoAgentModelEvent>>(() => undefined),
            return: async () => ({ done: true, value: undefined }),
          };
        },
      }),
    };
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      timeoutMs: 10,
    });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({ status: 'timeout', error: { code: 'TIMEOUT' } });
  });

  it('drains an aborted mutating tool outcome before the cancelled terminal event', async () => {
    const controller = new AbortController();
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const execute = vi.fn(() => {
      markExecutionStarted();
      return new Promise<never>(() => undefined);
    });
    const tool: MoAgentTool = {
      name: 'write_file',
      description: 'Mutate the workspace',
      inputSchema: { type: 'object' },
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
      execute,
    };
    const engine = new MoAgentRunEngine({
      provider: new ScriptedProvider([
        toolTurn({ name: 'write_file', arguments: ['{}'] }),
      ]),
      model: 'test-model',
      tools: [tool],
      timeoutMs: 1_000,
      criticalDrainTimeoutMs: 100,
    });
    const durableEvents: MoAgentEvent[] = [];
    const running = engine.run(
      { messages: initialMessages, signal: controller.signal },
      {
        durableSink: (event) => {
          durableEvents.push(event);
        },
      }
    );

    await executionStarted;
    controller.abort(new DOMException('cancelled while writing', 'AbortError'));
    const result = await running;

    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(execute).toHaveBeenCalledOnce();
    const startedIndex = durableEvents.findIndex((event) => event.type === 'tool_started');
    const failedIndex = durableEvents.findIndex((event) => event.type === 'tool_failed');
    const finishedIndex = durableEvents.findIndex((event) => event.type === 'run_finished');
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThan(startedIndex);
    expect(finishedIndex).toBeGreaterThan(failedIndex);
    expect(durableEvents[failedIndex]).toMatchObject({
      type: 'tool_failed',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
      result: { ok: false, error: { code: 'TOOL_EXECUTION_ABORTED' } },
    });
  });

  it('drains an in-flight mutating tool timeout before the timeout terminal event', async () => {
    const tool: MoAgentTool = {
      name: 'write_file',
      description: 'Mutate the workspace',
      inputSchema: { type: 'object' },
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
      execute: () => new Promise<never>(() => undefined),
    };
    const durableEvents: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider: new ScriptedProvider([
        toolTurn({ name: 'write_file', arguments: ['{}'] }),
      ]),
      model: 'test-model',
      tools: [tool],
      timeoutMs: 20,
      criticalDrainTimeoutMs: 100,
    });

    const result = await engine.run({ messages: initialMessages }, {
      durableSink: (event) => {
        durableEvents.push(event);
      },
    });

    expect(result).toMatchObject({ status: 'timeout', error: { code: 'TIMEOUT' } });
    const terminalTypes = durableEvents
      .filter((event) => ['tool_started', 'tool_failed', 'run_finished'].includes(event.type))
      .map((event) => event.type);
    expect(terminalTypes).toEqual(['tool_started', 'tool_failed', 'run_finished']);
    expect(durableEvents.find((event) => event.type === 'tool_failed')).toMatchObject({
      type: 'tool_failed',
      result: { ok: false, error: { code: 'TOOL_EXECUTION_ABORTED' } },
    });
  });

  it('returns a structured timeout after independently draining run_finished', async () => {
    const provider: MoAgentModelProvider = {
      name: 'never-ending',
      complete: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<MoAgentModelEvent>>(() => undefined),
            return: async () => ({ done: true, value: undefined }),
          };
        },
      }),
    };
    const durableEvents: MoAgentEvent[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      timeoutMs: 20,
      criticalDrainTimeoutMs: 100,
    });

    const result = await engine.run({ messages: initialMessages }, {
      durableSink: (event) => {
        durableEvents.push(event);
      },
    });

    expect(result).toMatchObject({ status: 'timeout', error: { code: 'TIMEOUT' } });
    expect(durableEvents.at(-1)).toMatchObject({
      type: 'run_finished',
      result: { status: 'timeout' },
    });
  });

  it('returns structured cancellation, drains durability, and does not start aborted observers', async () => {
    const controller = new AbortController();
    let markProviderWaiting!: () => void;
    const providerWaiting = new Promise<void>((resolve) => {
      markProviderWaiting = resolve;
    });
    const provider: MoAgentModelProvider = {
      name: 'cancelled-provider',
      complete: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              markProviderWaiting();
              return new Promise<IteratorResult<MoAgentModelEvent>>(() => undefined);
            },
            return: async () => ({ done: true, value: undefined }),
          };
        },
      }),
    };
    const durableTypes: string[] = [];
    const observerTypes: string[] = [];
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      timeoutMs: 1_000,
      criticalDrainTimeoutMs: 100,
    });
    const running = engine.run(
      { messages: initialMessages, signal: controller.signal },
      {
        durableSink: (event) => {
          durableTypes.push(event.type);
        },
        observers: [(event) => {
          observerTypes.push(event.type);
        }],
      }
    );

    await providerWaiting;
    controller.abort(new DOMException('cancelled by caller', 'AbortError'));
    const result = await running;

    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(durableTypes.at(-1)).toBe('run_finished');
    expect(observerTypes).not.toContain('run_finished');
  });

  it('bounds the independent critical drain window', async () => {
    const provider: MoAgentModelProvider = {
      name: 'never-ending',
      complete: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<MoAgentModelEvent>>(() => undefined),
            return: async () => ({ done: true, value: undefined }),
          };
        },
      }),
    };
    const terminalSink = vi.fn(() => new Promise<void>(() => undefined));
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      timeoutMs: 20,
      criticalDrainTimeoutMs: 10,
    });

    await expect(engine.run({ messages: initialMessages }, {
      durableSink: (event) => event.type === 'run_finished'
        ? terminalSink()
        : undefined,
    })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(terminalSink).toHaveBeenCalledOnce();
  });

  it('returns cancelled without contacting the provider when the caller is already aborted', async () => {
    const provider = new ScriptedProvider([]);
    const engine = new MoAgentRunEngine({ provider, model: 'test-model' });
    const controller = new AbortController();
    controller.abort(new Error('user paused'));
    const events: MoAgentEvent[] = [];

    const result = await engine.run(
      { messages: initialMessages, signal: controller.signal },
      (event) => {
        events.push(event);
      }
    );

    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(provider.requests).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(['run_started', 'run_finished']);
  });

  it('turns provider failures into a structured failed result', async () => {
    const upstreamError = new Error('upstream disconnected', {
      cause: { token: 'must-not-cross-public-event-boundary' },
    });
    const provider = new ScriptedProvider([upstreamError]);
    const engine = new MoAgentRunEngine({ provider, model: 'test-model' });
    const events: MoAgentEvent[] = [];

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'RUN_FAILED', message: 'upstream disconnected' },
    });
    expect(result.error?.cause).toBe(upstreamError);
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      result: {
        status: 'failed',
        error: { code: 'RUN_FAILED', message: 'MoAgent run ended with RUN_FAILED.' },
      },
    });
    expect(events.at(-1)).not.toHaveProperty('result.error.cause');
    expect(JSON.stringify(events.at(-1))).not.toContain('must-not-cross-public-event-boundary');
  });

  it('rejects a tool-call finish that contains no tool call', async () => {
    const provider = new ScriptedProvider([
      [{ type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' }],
    ]);
    const engine = new MoAgentRunEngine({ provider, model: 'test-model' });

    const result = await engine.run({ messages: initialMessages });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MISSING_TOOL_CALLS' },
    });
  });

  it('compacts provider context before the request and exposes only safe compaction counts', async () => {
    const provider = new ScriptedProvider([[
      { type: 'text_delta', delta: 'done' },
      { type: 'finish', reason: 'stop', rawReason: 'stop' },
    ]]);
    const protectedMessages: MoAgentMessage[] = [
      { role: 'system', content: 'Policy' },
      { role: 'user', content: 'Newest task' },
    ];
    const inputBudget = JSON.stringify({ messages: protectedMessages, tools: [] }).length;
    const contextManager = new MoAgentContextManager({
      contextWindowTokens: 100_000,
      reservedOutputTokens: 1_000,
      maxInputTokens: inputBudget,
      tokenEstimator: (messages, tools) => JSON.stringify({ messages, tools }).length,
    });
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      contextManager,
      requireTerminalTool: false,
      idFactory: () => 'run-context',
    });
    const events: MoAgentEvent[] = [];

    const result = await engine.run({
      messages: [
        protectedMessages[0],
        { role: 'user', content: 'obsolete task '.repeat(100) },
        {
          role: 'assistant',
          content: 'obsolete answer '.repeat(100),
          reasoningContent: 'private reasoning '.repeat(100),
        },
        protectedMessages[1],
      ],
    }, (event) => {
      events.push(event);
    });

    expect(result.status).toBe('completed');
    expect(provider.requests[0].messages).toEqual(protectedMessages);
    expect(events.find((event) => event.type === 'context_compacted')).toMatchObject({
      type: 'context_compacted',
      removedReasoningMessages: 1,
      droppedGroups: 2,
      inputBudgetTokens: inputBudget,
    });
  });

  it('returns the structured context budget error without contacting the provider', async () => {
    const provider = new ScriptedProvider([]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      contextManager: new MoAgentContextManager({
        contextWindowTokens: 100,
        reservedOutputTokens: 10,
        maxInputTokens: 20,
      }),
    });

    const result = await engine.run({
      messages: [
        { role: 'system', content: 'non-removable policy '.repeat(20) },
        { role: 'user', content: 'non-removable current task' },
      ],
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'CONTEXT_BUDGET_EXCEEDED' },
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('derives a framework operation ID and passes it through events and tool context', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: {} }));
    const provider = new ScriptedProvider([
      toolTurn({ name: 'submit_result', id: 'model-call-id', arguments: ['{}'] }),
    ]);
    const engine = new MoAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [terminalTool(execute)],
      idFactory: () => 'run-operation-id',
    });
    const events: MoAgentEvent[] = [];

    const result = await engine.run({ messages: initialMessages }, (event) => {
      events.push(event);
    });
    const expected = createMoAgentOperationId('run-operation-id', 1, {
      id: 'model-call-id',
      name: 'submit_result',
    });

    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ operationId: expected })
    );
    expect(events.find((event) => event.type === 'tool_started')).toMatchObject({
      operationId: expected,
      effect: 'pure',
      idempotency: 'intrinsic',
    });
    expect(events.find((event) => event.type === 'tool_completed')).toMatchObject({
      operationId: expected,
    });
  });

  it('stops before a tool side effect when the durable sink rejects tool_started', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: {} }));
    const engine = new MoAgentRunEngine({
      provider: new ScriptedProvider([
        toolTurn({ name: 'submit_result', arguments: ['{}'] }),
      ]),
      model: 'test-model',
      tools: [terminalTool(execute)],
    });

    await expect(engine.run({ messages: initialMessages }, {
      durableSink: (event) => {
        if (event.type === 'tool_started') throw new Error('ledger unavailable');
      },
    })).rejects.toThrow('ledger unavailable');
    expect(execute).not.toHaveBeenCalled();
  });

  it('bounds and isolates hanging observers from the critical run loop', async () => {
    const diagnostics = vi.fn();
    const engine = new MoAgentRunEngine({
      provider: new ScriptedProvider([[
        { type: 'text_delta', delta: 'visible' },
        { type: 'finish', reason: 'stop', rawReason: 'stop' },
      ]]),
      model: 'test-model',
      requireTerminalTool: false,
      timeoutMs: 1_000,
      observerTimeoutMs: 5,
    });

    const result = await engine.run({ messages: initialMessages }, {
      observers: [() => new Promise<void>(() => undefined)],
      onObserverError: diagnostics,
    });

    expect(result.status).toBe('completed');
    expect(diagnostics).toHaveBeenCalled();
  });
});
