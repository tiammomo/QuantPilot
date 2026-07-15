import { describe, expect, it } from 'vitest';
import {
  mapDbQueueItem,
  normalizeResult,
  normalizeCoverage,
  normalizeQueueStatus,
  normalizeSkillLockSnapshot,
} from './runtime-mappers';

describe('evaluation runtime mappers', () => {
  it('normalizes unknown queue states to a terminal failure', () => {
    expect(normalizeQueueStatus('running')).toBe('running');
    expect(normalizeQueueStatus('unexpected')).toBe('failed');
  });

  it('maps legacy persisted queue rows with safe execution defaults', () => {
    const item = mapDbQueueItem({
      id: 'queue-1',
      status: 'queued',
      cli: 'moagent',
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
      evaluatorId: 'rule-strict',
      concurrency: 1,
      mode: 'contract',
      selectedCases: ['case-a'],
      createdAt: '2026-07-13T00:00:00.000Z',
    });
  });

  it('restores persisted E2E queue execution settings without the file queue', () => {
    const item = mapDbQueueItem({
      id: 'queue-e2e',
      status: 'queued',
      cli: 'moagent',
      model: 'deepseek-v4-flash',
      reasoningEffort: '',
      evaluatorId: 'rule-balanced',
      concurrency: 6,
      mode: 'e2e',
      selectedCases: ['stock-diagnosis-citic-no-false-clarification'],
      limit: 1,
      keepProjects: true,
      reportId: null,
      reportPath: null,
      logPath: null,
      pid: null,
      exitCode: null,
      error: null,
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
      startedAt: null,
      finishedAt: null,
    });

    expect(item).toMatchObject({
      id: 'queue-e2e',
      evaluatorId: 'rule-balanced',
      concurrency: 6,
      mode: 'e2e',
      keepProjects: true,
    });
  });

  it('accepts the current skill lock sha256 field names', () => {
    const snapshot = normalizeSkillLockSnapshot({
      schemaVersion: 2,
      skills: {
        research: { version: '2.0.0', sourceSha256: 'source-hash', packageSha256: 'package-hash' },
      },
    });

    expect(snapshot.skills.research).toMatchObject({
      version: '2.0.0',
      hash: 'source-hash',
      packageHash: 'package-hash',
      sourceSha256: 'source-hash',
      packageSha256: 'package-hash',
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

  it('preserves per-case E2E execution and repair provenance', () => {
    const result = normalizeResult({
      id: 'case-e2e',
      passed: true,
      requestId: 'parent-run',
      repairAttempts: 1,
      platformRepairCount: 1,
      agentExecuted: true,
      agentExecution: {
        executed: true,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        requestId: 'parent-run',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: '2026-07-14T00:01:00.000Z',
      },
    }, new Map(), {});

    expect(result).toMatchObject({
      requestId: 'parent-run',
      repairAttempts: 1,
      platformRepairCount: 1,
      agentExecuted: true,
      agentExecution: {
        executed: true,
        model: 'deepseek-v4-flash',
        requestId: 'parent-run',
      },
    });
  });
});
