import { describe, expect, it } from 'vitest';
import { getDefaultQuantSkillIds, type QuantSkillsRegistry } from './skills-registry';

describe('skills registry defaults', () => {
  it('installs only stable core skills unless a capability explicitly requests more', () => {
    const registry: QuantSkillsRegistry = {
      schemaVersion: 1,
      policy: {
        targetCoreSkillCount: 2,
        description: 'test',
      },
      coreSkills: [
        { id: 'stable-skill', name: 'Stable', version: '1.0.0', status: 'stable', boundary: 'stable' },
        { id: 'planned-skill', name: 'Planned', version: '1.0.0', status: 'planned', boundary: 'planned' },
      ],
    };

    expect(getDefaultQuantSkillIds(registry)).toEqual(['stable-skill']);
  });
});
