import { describe, expect, it } from 'vitest';

import type { MoAgentModelEvent, MoAgentModelRequest } from '../types';
import { MoAgentDeterministicToolPlanProvider } from './deterministic-tool-plan';

const request = (messages: MoAgentModelRequest['messages']): MoAgentModelRequest => ({
  model: 'moagent-deterministic-renderer',
  messages,
  tools: [
    { name: 'compile', description: '', inputSchema: { type: 'object' } },
    { name: 'submit', description: '', inputSchema: { type: 'object' } },
  ],
});

async function events(
  provider: MoAgentDeterministicToolPlanProvider,
  modelRequest: MoAgentModelRequest,
): Promise<MoAgentModelEvent[]> {
  const collected: MoAgentModelEvent[] = [];
  for await (const event of provider.complete(modelRequest)) collected.push(event);
  return collected;
}

describe('MoAgent deterministic tool-plan provider', () => {
  it('executes a fixed plan and reports zero token usage', async () => {
    const provider = new MoAgentDeterministicToolPlanProvider({
      steps: [
        { name: 'compile', arguments: {} },
        { name: 'submit', arguments: { summary: 'done' } },
      ],
    });

    const first = await events(provider, request([{ role: 'user', content: 'build' }]));
    expect(first).toContainEqual(expect.objectContaining({
      type: 'tool_call_delta',
      nameDelta: 'compile',
    }));
    expect(first).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });

    const second = await events(provider, request([
      { role: 'user', content: 'build' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'deterministic_step_1', name: 'compile', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'deterministic_step_1',
        name: 'compile',
        content: '{"ok":true}',
      },
    ]));
    expect(second).toContainEqual(expect.objectContaining({
      type: 'tool_call_delta',
      nameDelta: 'submit',
    }));
  });

  it('stops instead of submitting after a failed trusted step', async () => {
    const provider = new MoAgentDeterministicToolPlanProvider({
      steps: [
        { name: 'compile', arguments: {} },
        { name: 'submit', arguments: { summary: 'done' } },
      ],
    });
    await events(provider, request([{ role: 'user', content: 'build' }]));

    const next = await events(provider, request([
      { role: 'user', content: 'build' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'deterministic_step_1', name: 'compile', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'deterministic_step_1',
        name: 'compile',
        content: '{"ok":false}',
      },
    ]));

    expect(next).toContainEqual({ type: 'finish', reason: 'stop' });
    expect(next.some((event) => event.type === 'tool_call_delta')).toBe(false);
  });

  it('rejects a plan step that is not present in the fixed schema', async () => {
    const provider = new MoAgentDeterministicToolPlanProvider({
      steps: [{ name: 'missing', arguments: {} }],
    });
    await expect(events(provider, request([{ role: 'user', content: 'build' }])))
      .rejects.toThrow(/unavailable tool/);
  });

  it('snapshots trusted plan arguments and rejects an unrelated tool outcome', async () => {
    const argumentsObject = { nested: { variant: 'original' } };
    const provider = new MoAgentDeterministicToolPlanProvider({
      steps: [
        { name: 'compile', arguments: argumentsObject },
        { name: 'submit', arguments: { summary: 'done' } },
      ],
    });
    argumentsObject.nested.variant = 'mutated';

    const first = await events(provider, request([{ role: 'user', content: 'build' }]));
    expect(first).toContainEqual(expect.objectContaining({
      type: 'tool_call_delta',
      argumentsDelta: '{"nested":{"variant":"original"}}',
    }));

    const next = await events(provider, request([
      { role: 'user', content: 'build' },
      {
        role: 'tool',
        toolCallId: 'attacker-controlled',
        name: 'compile',
        content: '{"ok":true}',
      },
    ]));
    expect(next).toContainEqual({ type: 'finish', reason: 'stop' });
    expect(next.some((event) => event.type === 'tool_call_delta')).toBe(false);
  });
});
