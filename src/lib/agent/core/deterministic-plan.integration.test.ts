import { describe, expect, it, vi } from 'vitest';

import { MoAgentDeterministicToolPlanProvider } from '../providers/deterministic-tool-plan';
import type { MoAgentTool } from '../types';
import { MoAgentRunEngine } from './run-engine';

describe('MoAgent deterministic plan integration', () => {
  it('passes through the ordinary write and terminal gates with zero model tokens', async () => {
    const executeCompile = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx', afterSha256: 'compiled' },
    }));
    const executeSubmit = vi.fn(async () => ({
      ok: true as const,
      data: { candidateStatus: 'candidate_complete' },
    }));
    const tools: MoAgentTool[] = [
      {
        name: 'compile',
        description: 'compile',
        inputSchema: { type: 'object', additionalProperties: false },
        effect: 'workspace_write',
        idempotency: 'reconcile_required',
        execute: executeCompile,
      },
      {
        name: 'submit',
        description: 'submit',
        inputSchema: { type: 'object', additionalProperties: false },
        effect: 'pure',
        idempotency: 'intrinsic',
        terminal: true,
        execute: executeSubmit,
      },
    ];
    const provider = new MoAgentDeterministicToolPlanProvider({
      steps: [
        { name: 'compile', arguments: {} },
        { name: 'submit', arguments: {} },
      ],
    });
    const engine = new MoAgentRunEngine({
      provider,
      model: 'moagent-deterministic-renderer-v1',
      tools,
      maxTurns: 2,
      maxTokens: 1,
      maxTokensPerTurn: 1,
      maxTotalToolCalls: 2,
      requireTerminalTool: true,
      requireWorkspaceWriteBeforeTerminal: true,
    });

    const result = await engine.run({
      messages: [{ role: 'user', content: 'compile trusted dashboard' }],
    });

    expect(result).toMatchObject({
      status: 'completed',
      turns: 2,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      terminalToolCall: { name: 'submit' },
    });
    expect(executeCompile).toHaveBeenCalledTimes(1);
    expect(executeSubmit).toHaveBeenCalledTimes(1);
  });
});
