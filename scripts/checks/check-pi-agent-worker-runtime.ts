#!/usr/bin/env node

import assert from 'node:assert/strict';

import { PiAgentRunEngine } from '../../src/lib/agent/pi/run-engine';
import type {
  PiAgentModelEvent,
  PiAgentModelProvider,
  PiAgentModelRequest,
  PiAgentTool,
} from '../../src/lib/agent/types';

class WorkerSmokeProvider implements PiAgentModelProvider {
  readonly name = 'pi-agent-worker-smoke';

  async *complete(
    _request: PiAgentModelRequest,
  ): AsyncIterable<PiAgentModelEvent> {
    yield {
      type: 'response_start',
      responseId: 'pi-agent-worker-smoke-response',
      model: 'pi-agent-worker-smoke-model',
    };
    yield {
      type: 'tool_call_delta',
      index: 0,
      id: 'pi-agent-worker-smoke-submit',
      nameDelta: 'submit_result',
      argumentsDelta: '{"artifact":"smoke"}',
    };
    yield {
      type: 'usage',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cachedInputTokens: 0,
        cacheMissInputTokens: 1,
      },
    };
    yield {
      type: 'finish',
      reason: 'tool_calls',
      rawReason: 'tool_calls',
    };
  }
}

const submitResult: PiAgentTool = {
  name: 'submit_result',
  description: 'Complete the isolated Worker runtime smoke.',
  inputSchema: {
    type: 'object',
    properties: {
      artifact: { type: 'string' },
    },
    required: ['artifact'],
    additionalProperties: false,
  },
  terminal: true,
  execute: async (input) => ({
    ok: true,
    data: input,
  }),
};

async function main(): Promise<void> {
  const engine = new PiAgentRunEngine({
    provider: new WorkerSmokeProvider(),
    model: 'pi-agent-worker-smoke-model',
    tools: [submitResult],
  });
  const result = await engine.run({
    runId: 'pi-agent-worker-runtime-smoke',
    messages: [{
      role: 'user',
      content: 'Complete the isolated Worker runtime smoke.',
    }],
    maxTurns: 2,
    maxTokens: 8,
    timeoutMs: 10_000,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.turns, 1);
  assert.equal(result.terminalToolCall?.name, 'submit_result');
  assert.equal(result.usage.totalTokens, 2);
  console.log('[pi-agent-worker-runtime] ok: ESM-only PI loop executed from the Worker CommonJS boundary');
}

main().catch((error) => {
  console.error('[pi-agent-worker-runtime] failed:', error);
  process.exitCode = 1;
});
