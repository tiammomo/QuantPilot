import { describe, expect, it } from 'vitest';

import type { Project as ProjectEntity } from '@/types/backend';
import { serializeProject } from './project';

function project(preferredCli: string): ProjectEntity {
  const now = new Date('2026-07-28T00:00:00.000Z');
  return {
    id: 'project-1',
    name: 'PI project',
    status: 'idle',
    preferredCli,
    selectedModel: 'local_qwen:qwen3.5-9b-q5km',
    agentProfileId: 'quantpilot.finance-research',
    agentProfileVersion: '1.0.0',
    dataAgentCompositionSha256: `sha256:${'a'.repeat(64)}`,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  };
}

describe('project serialization', () => {
  it('serializes the PI runtime identity', () => {
    expect(serializeProject(project('pi')).preferredCli).toBe('pi');
  });
});
