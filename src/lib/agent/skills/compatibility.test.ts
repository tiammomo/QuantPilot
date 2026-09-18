import { describe, expect, it } from 'vitest';
import { assessSkillCompatibility } from './compatibility';
import type { PiAgentSkillRuntimeCapsule } from './types';
const capsule = { phases: ['data-preparation'], requiresTools: ['read'], requiresOneOfToolSets: [['fetch', 'save'], ['cached']] } as PiAgentSkillRuntimeCapsule;
describe('shared execution and market compatibility', () => {
  it('requires a complete alternative tool group', () => {
    expect(assessSkillCompatibility(capsule, 'data-preparation', ['read', 'fetch']).compatible).toBe(false);
    expect(assessSkillCompatibility(capsule, 'data-preparation', ['read', 'cached']).compatible).toBe(true);
  });
  it('never bypasses required tools or phase restrictions', () => {
    expect(assessSkillCompatibility(capsule, 'planning', ['read', 'cached']).compatible).toBe(false);
    expect(assessSkillCompatibility(capsule, 'data-preparation', ['cached']).missingTools).toEqual(['read']);
  });
});
