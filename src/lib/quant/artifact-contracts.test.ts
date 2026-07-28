import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DATA_AGENT_WORKSPACE_RELATIVE_PATH } from '@/lib/data-agent';
import { validateQuantArtifactContracts } from './artifact-contracts';

const roots: string[] = [];

async function writeWorkspace(
  framework: 'PI Agent',
  executorId: 'pi',
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-artifact-contract-'));
  roots.push(root);
  const workspacePath = path.join(root, DATA_AGENT_WORKSPACE_RELATIVE_PATH);
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  await fs.writeFile(workspacePath, JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'project-1',
    projectId: 'project-1',
    projectName: 'PI project',
    platform: 'QuantPilot',
    composition: {
      schemaVersion: 1,
      profile: { id: 'quantpilot.finance', version: '1.0.0' },
      domainPacks: [{ id: 'finance.research', version: '1.0.0' }],
      deliveryPack: { id: 'workspace.next-dashboard', version: '1.0.0' },
      capability: { id: 'stock_diagnosis' },
      sha256: `sha256:${'a'.repeat(64)}`,
    },
    runtime: {
      framework,
      executorId,
      modelId: 'local_qwen:qwen3.5-9b-q5km',
      modelProfileId: 'local-qwen',
    },
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  }), 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true }),
  ));
});

describe('PI workspace artifact contract', () => {
  it('accepts the canonical PI Agent workspace identity', async () => {
    const root = await writeWorkspace('PI Agent', 'pi');
    const report = await validateQuantArtifactContracts({
      projectPath: root,
      projectId: 'project-1',
    });

    expect(report.checks.find((check) => check.id === 'workspace_contract'))
      .toMatchObject({ status: 'passed' });
  });
});
