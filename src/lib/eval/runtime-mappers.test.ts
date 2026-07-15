import { describe, expect, it } from 'vitest';
import {
  mapDbEvalRun,
  mapDbQueueItem,
  normalizeResult,
  normalizeCoverage,
  normalizeQueueStatus,
  normalizeRun,
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

  it('retains E2E quality telemetry through file and DB-backed report mapping', () => {
    const quality = {
      passed: true,
      problems: [],
      thresholds: {
        maxTurnsPerCase: 20,
        maxCacheMissInputTokensPerCase: 120_000,
        maxUnexpectedToolFailures: 0,
      },
      summary: {
        caseCount: 1,
        measuredCaseCount: 1,
        missingMetricsCaseIds: [],
        turns: { total: 6, average: 6, max: { id: 'case-e2e', value: 6 } },
        cacheMissInputTokens: {
          total: 24_000,
          average: 24_000,
          max: { id: 'case-e2e', value: 24_000 },
        },
        tools: { unexpectedFailureCount: 0, affectedCaseIds: [] },
      },
    };
    const run = normalizeRun('/tmp/report-1.json', 1, {
      passed: true,
      total: 0,
      passedCount: 0,
      failedCount: 0,
      metadata: { e2eQuality: quality },
      e2eQuality: quality,
      results: [],
    }, []);
    const restored = mapDbEvalRun({
      id: run.id,
      fileName: run.fileName,
      filePath: run.filePath,
      reportCreatedAt: new Date(run.createdAt),
      mtimeMs: run.mtimeMs,
      passed: run.passed,
      total: run.total,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
      passRate: run.passRate,
      averageScore: run.averageScore,
      durationMs: run.durationMs,
      metadata: run.metadata,
      coverage: run.coverage,
      results: run.results,
    });

    expect(run.e2eQuality).toMatchObject({
      passed: true,
      summary: { turns: { average: 6 } },
    });
    expect(restored.e2eQuality).toEqual(run.e2eQuality);
  });

  it('fails safely for legacy DB JSON null instead of dropping the entire run list', () => {
    const restored = mapDbEvalRun({
      id: 'report-legacy-null',
      fileName: 'report-legacy-null.json',
      filePath: 'tmp/report-legacy-null.json',
      reportCreatedAt: new Date('2026-07-15T00:00:00.000Z'),
      mtimeMs: 1,
      passed: false,
      total: 0,
      passedCount: 0,
      failedCount: 0,
      passRate: 0,
      averageScore: 0,
      durationMs: 0,
      metadata: null,
      coverage: null,
      results: null,
    });

    expect(restored.metadata).toMatchObject({
      reportSchemaVersion: null,
      runtime: { cli: 'benchmark', model: 'deterministic' },
    });
    expect(restored.e2eQuality).toBeNull();
    expect(restored.coverage.byCapability).toEqual({});
    expect(restored.results).toEqual([]);
  });
});
