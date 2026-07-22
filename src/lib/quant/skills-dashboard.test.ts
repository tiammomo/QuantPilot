import { describe, expect, it } from 'vitest';
import { getSkillsDashboardData } from './skills-dashboard';

describe('skills dashboard package health', () => {
  it('reports every core Skill as a complete, immutable release package', async () => {
    const dashboard = await getSkillsDashboardData();

    expect(dashboard.skills).toHaveLength(12);
    expect(dashboard.skills.map((skill) => skill.id)).toContain('query-rewrite');
    expect(dashboard.totals.error).toBe(0);
    expect(dashboard.totals.warning).toBe(0);
    for (const skill of dashboard.skills) {
      expect(skill.health).toMatchObject({ status: 'ok', missing: [] });
      expect(skill.source.hasAgents).toBe(true);
      expect(skill.source.hasReferences).toBe(true);
      expect(skill.source.hasScripts).toBe(true);
      expect(skill.references.length).toBeGreaterThan(0);
      expect(skill.scripts.length).toBeGreaterThan(0);
      expect(skill.changelog.currentRelease?.snapshot?.exists).toBe(true);
    }
  });
});
