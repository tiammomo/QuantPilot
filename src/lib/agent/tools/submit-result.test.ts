import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MoAgentToolContext } from '@/lib/agent/types';
import { createSubmitResultTool } from './submit-result';

const context: MoAgentToolContext = {
  runId: 'run-submit-result',
  turn: 1,
  toolCallId: 'call-submit-result',
  operationId: 'operation-submit-result',
  signal: new AbortController().signal,
};

describe('submit_result candidate semantics', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-submit-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('ends only the physical run with a verified candidate projection', async () => {
    await fs.mkdir(path.join(workspace, 'app'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), 'export default function Page() {}\n');
    const tool = createSubmitResultTool({ workspaceRoot: workspace });
    const input = tool.parseInput!({
      summary: 'dashboard source prepared',
      artifacts: ['app/page.tsx', 'app/page.tsx'],
    });

    const result = await tool.execute(input, context);

    expect(tool).toMatchObject({ terminal: true, effect: 'pure' });
    expect(tool.description).toContain('does not complete the product Mission');
    expect(result).toMatchObject({
      ok: true,
      data: {
        candidateStatus: 'candidate_complete',
        artifacts: ['app/page.tsx'],
        verifiedArtifacts: ['app/page.tsx'],
      },
    });
    expect(result.content).toContain('Candidate submitted for platform verification');
  });

  it('fails closed when a declared artifact is absent', async () => {
    const tool = createSubmitResultTool({ workspaceRoot: workspace });
    const input = tool.parseInput!({
      summary: 'candidate',
      artifacts: ['app/missing.tsx'],
    });

    const result = await tool.execute(input, context);

    expect(result).toMatchObject({ ok: false });
    expect(result.content).not.toContain('Candidate submitted');
  });
});
