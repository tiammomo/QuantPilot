import { describe, expect, it } from 'vitest';
import {
  mapDbQueueItem,
  normalizeCoverage,
  normalizeQueueStatus,
  normalizeSkillLockSnapshot,
} from './runtime-mappers';

describe('evaluation runtime mappers', () => {
  it('normalizes unknown queue states to a terminal failure', () => {
    expect(normalizeQueueStatus('running')).toBe('running');
    expect(normalizeQueueStatus('unexpected')).toBe('failed');
  });

  it('maps persisted queue timestamps and JSON selections', () => {
    const item = mapDbQueueItem({
      id: 'queue-1',
      status: 'queued',
      cli: 'claude',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      selectedCases: ['case-a'],
      limit: 1,
      keepProjects: false,
      reportId: null,
      reportPath: null,
      logPath: null,
      pid: null,
      exitCode: null,
      error: null,
      createdAt: new Date('2026-07-13T00:00:00.000Z'),
      startedAt: null,
      finishedAt: null,
    });

    expect(item).toMatchObject({
      id: 'queue-1',
      status: 'queued',
      selectedCases: ['case-a'],
      createdAt: '2026-07-13T00:00:00.000Z',
    });
  });

  it('drops malformed skill metadata while preserving valid versions', () => {
    const snapshot = normalizeSkillLockSnapshot({
      schemaVersion: 2,
      skills: {
        research: { version: '1.2.0', hash: 'abc' },
        malformed: null,
      },
    });

    expect(snapshot.skills.research).toMatchObject({ version: '1.2.0', hash: 'abc' });
    expect(snapshot.skills.malformed).toMatchObject({ version: null, hash: null });
  });

  it('normalizes sparse coverage buckets into numeric counters', () => {
    const coverage = normalizeCoverage({
      byCapability: { research: { total: 3, passed: 2, failed: 1 } },
      requiredCoverage: { capabilities: ['research'], tags: ['real-data'] },
    });

    expect(coverage.byCapability.research).toEqual({ total: 3, passed: 2, failed: 1 });
    expect(coverage.requiredCoverage.tags).toEqual(['real-data']);
  });
});
