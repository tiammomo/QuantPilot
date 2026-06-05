import type { QuantEvalModelComparison, QuantEvalRun, QuantEvalSkillVersionImpact } from './types';

export function buildModelComparison(runs: QuantEvalRun[]): QuantEvalModelComparison[] {
  const groups = new Map<string, QuantEvalRun[]>();
  runs.forEach((run) => {
    const cli = run.metadata.runtime.cli ?? 'unknown';
    const model = run.metadata.runtime.model ?? 'unknown';
    const reasoningEffort = run.metadata.runtime.reasoningEffort ?? '-';
    const key = `${cli}:${model}:${reasoningEffort}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  });

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const sorted = [...group].sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latest = sorted[0];
      return {
        key,
        cli: latest.metadata.runtime.cli ?? 'unknown',
        model: latest.metadata.runtime.model ?? 'unknown',
        reasoningEffort: latest.metadata.runtime.reasoningEffort ?? '-',
        runs: sorted.length,
        latestRunId: latest.id,
        latestPassRate: latest.passRate,
        averagePassRate: Math.round(sorted.reduce((total, run) => total + run.passRate, 0) / sorted.length),
        latestAverageScore: latest.averageScore,
        averageScore: Math.round(sorted.reduce((total, run) => total + run.averageScore, 0) / sorted.length),
        latestCreatedAt: latest.createdAt,
      };
    })
    .sort((a, b) => b.latestCreatedAt.localeCompare(a.latestCreatedAt));
}

export function buildSkillVersionImpact(runs: QuantEvalRun[]): QuantEvalSkillVersionImpact[] {
  const groups = new Map<string, { skillId: string; version: string; runs: QuantEvalRun[] }>();

  runs.forEach((run) => {
    Object.entries(run.metadata.skillLockSnapshot.skills).forEach(([skillId, entry]) => {
      const version = entry.version ?? 'unknown';
      const key = `${skillId}@${version}`;
      const group = groups.get(key) ?? { skillId, version, runs: [] };
      group.runs.push(run);
      groups.set(key, group);
    });
  });

  return Array.from(groups.values())
    .map((group) => {
      const sorted = [...group.runs].sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latest = sorted[0];
      return {
        skillId: group.skillId,
        version: group.version,
        runs: sorted.length,
        latestRunId: latest.id,
        latestPassRate: latest.passRate,
        averagePassRate: Math.round(sorted.reduce((total, run) => total + run.passRate, 0) / sorted.length),
        latestAverageScore: latest.averageScore,
        averageScore: Math.round(sorted.reduce((total, run) => total + run.averageScore, 0) / sorted.length),
        latestCreatedAt: latest.createdAt,
      };
    })
    .sort((a, b) => b.latestCreatedAt.localeCompare(a.latestCreatedAt))
    .slice(0, 30);
}
