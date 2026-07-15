import { describe, expect, it } from 'vitest';

import { attestEvalReport, type EvalReportAttestationOptions } from './report-attestation';

const GIT = 'a'.repeat(40);
const options: EvalReportAttestationOptions = {
  mode: 'contract',
  expectedCaseIds: ['a', 'b'],
  expectedCasesSha256: 'cases-hash',
  expectedPromptsSha256: 'prompts-hash',
  frameworkVersion: 'moagent:1.7.0',
  buildRevision: 'build-current',
  gitRevision: GIT,
  qualityThresholds: {
    maxTurnsPerCase: 20,
    maxCacheMissInputTokensPerCase: 120_000,
    maxUnexpectedToolFailures: 0,
  },
  now: new Date('2026-07-15T01:00:00.000Z'),
};

function baseReport(mode: 'contract' | 'e2e') {
  const results = ['a', 'b'].map((id) => ({ id, passed: true, agentExecuted: false }));
  return {
    schemaVersion: 4,
    createdAt: '2026-07-15T00:02:00.000Z',
    passed: true,
    total: 2,
    passedCount: 2,
    failedCount: 0,
    metadata: {
      runtime: {
        cli: 'moagent',
        model: mode === 'e2e' ? 'deepseek-v4-flash' : null,
        frameworkVersion: 'moagent:1.7.0',
        buildRevision: 'build-current',
        agentExecuted: false,
        executedCaseCount: 0,
        unattestedCaseIds: [],
      },
      startedAt: '2026-07-15T00:00:00.000Z',
      finishedAt: '2026-07-15T00:01:30.000Z',
      suite: {
        mode,
        executionClass: mode === 'e2e' ? 'live_mission_e2e' : 'deterministic_contract',
      },
      retention: {
        databaseEvidenceRetained: mode === 'e2e',
        workspaceRetained: mode === 'e2e',
      },
      provenance: {
        gitRevision: GIT,
        frameworkVersion: 'moagent:1.7.0',
        buildRevision: 'build-current',
        casesSha256: 'cases-hash',
        promptsSha256: 'prompts-hash',
      },
    },
    results,
  };
}

function execution(id: string) {
  const requestId = `request-${id}`;
  const runId = `run-${id}`;
  const missionId = `mission-${id}`;
  const generationId = `generation-${id}`;
  const receiptId = `receipt-${id}`;
  const receiptHash = `sha256:${(id === 'a' ? 'a' : 'b').repeat(64)}`;
  const usage = {
    inputTokens: 25_000,
    outputTokens: 2_000,
    totalTokens: 27_000,
    cachedInputTokens: 5_000,
    cacheMissInputTokens: 20_000,
    reasoningTokens: 0,
  };
  const tools = {
    total: 4,
    succeeded: 4,
    failed: 0,
    uncertain: 0,
    unexpectedFailureCount: 0,
    workspaceWriteSucceeded: 1,
    submitResultSucceeded: 1,
  };
  return {
    id,
    requestId,
    passed: true,
    failures: [],
    agentExecuted: true,
    validation: { status: 'passed', checks: [{ status: 'passed' }] },
    visualCheck: { passed: true },
    eventAudit: { errorCount: 0 },
    missionAcceptance: {
      missionId,
      generationId,
      status: 'completed',
      candidateVersion: 1,
      acceptedReceiptId: receiptId,
      acceptedReceiptHash: receiptHash,
      acceptedReceiptType: 'acceptance',
      acceptedReceiptVerdict: 'accepted',
      acceptedSourceRunId: runId,
      acceptedSourceRequestId: requestId,
      acceptedCandidateSource: 'moagent_submit_result',
    },
    agentExecution: {
      executed: true,
      cli: 'moagent',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      requestId,
      runIds: [runId],
      runs: [{
        id: runId,
        runInstanceId: `instance-${id}`,
        requestId,
        status: 'candidate_complete',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        frameworkVersion: 'moagent:1.7.0',
        buildRevision: 'build-current',
        startedAt: '2026-07-15T00:00:00.000Z',
        completedAt: '2026-07-15T00:01:00.000Z',
        turns: 5,
        usage,
        tools,
      }],
      missionId,
      generationId,
      missionStatus: 'completed',
      candidateVersion: 1,
      acceptedReceiptId: receiptId,
      acceptedReceiptHash: receiptHash,
      acceptedReceiptType: 'acceptance',
      acceptedReceiptVerdict: 'accepted',
      acceptedSourceRunId: runId,
      acceptedSourceRequestId: requestId,
      acceptedCandidateSource: 'moagent_submit_result',
      frameworkVersion: 'moagent:1.7.0',
      buildRevision: 'build-current',
      gitRevision: GIT,
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:01:00.000Z',
      turns: 5,
      usage,
      tools,
    },
  };
}

describe('eval report attestation', () => {
  it('accepts a complete current-build deterministic contract report', () => {
    expect(attestEvalReport(baseReport('contract'), options)).toMatchObject({
      passed: true,
      problems: [],
    });
  });

  it('rejects a stale, partial, contradictory contract report', () => {
    const report = baseReport('contract');
    report.metadata.runtime.cli = 'claude';
    report.metadata.provenance.gitRevision = 'b'.repeat(40);
    report.results = [report.results[0]];

    expect(attestEvalReport(report, options).problems).toEqual(expect.arrayContaining([
      expect.stringContaining('runtime.cli'),
      expect.stringContaining('git revision'),
      expect.stringContaining('case 集不完整'),
      expect.stringContaining('total'),
    ]));
  });

  it('accepts only Mission-backed E2E metrics and applies efficiency thresholds', () => {
    const report = baseReport('e2e');
    report.metadata.runtime.agentExecuted = true;
    report.metadata.runtime.executedCaseCount = 2;
    const secondExecution = execution('b');
    report.results = [execution('a'), secondExecution];
    const e2eOptions = { ...options, mode: 'e2e' as const };

    expect(attestEvalReport(report, e2eOptions)).toMatchObject({
      passed: true,
      problems: [],
    });

    secondExecution.agentExecution.turns = 21;
    secondExecution.agentExecution.runs[0].turns = 21;
    secondExecution.agentExecution.tools.succeeded = 3;
    secondExecution.agentExecution.tools.failed = 1;
    secondExecution.agentExecution.tools.unexpectedFailureCount = 1;
    secondExecution.agentExecution.runs[0].tools.succeeded = 3;
    secondExecution.agentExecution.runs[0].tools.failed = 1;
    secondExecution.agentExecution.runs[0].tools.unexpectedFailureCount = 1;
    report.passed = false;
    expect(attestEvalReport(report, e2eOptions).problems).toEqual(expect.arrayContaining([
      'b turns=21 超过阈值 20',
      'unexpected tool failures=1 超过阈值 0',
    ]));
  });

  it.each([
    'unversioned:moagent:1.7.0',
    `${'a'.repeat(40)}-dirty.unavailable`,
  ])('rejects E2E evidence from a non-attestable build revision: %s', (buildRevision) => {
    const report = baseReport('e2e');
    report.metadata.runtime.agentExecuted = true;
    report.metadata.runtime.executedCaseCount = 2;
    report.metadata.runtime.buildRevision = buildRevision;
    report.metadata.provenance.buildRevision = buildRevision;
    const executions = [execution('a'), execution('b')];
    for (const result of executions) {
      result.agentExecution.buildRevision = buildRevision;
      result.agentExecution.runs[0].buildRevision = buildRevision;
    }
    report.results = executions;

    expect(attestEvalReport(report, {
      ...options,
      mode: 'e2e',
      buildRevision,
    }).problems).toContain(
      'E2E 发布证据要求可重现的 buildRevision，拒绝 unversioned/dirty.unavailable',
    );
  });

  it('rejects missing schema, future timestamps, and cross-case execution reuse', () => {
    const missingSchema = baseReport('contract');
    delete (missingSchema as { schemaVersion?: number }).schemaVersion;
    expect(attestEvalReport(missingSchema, options).problems).toContain(
      '报告 schemaVersion 必须为 4，实际为 missing',
    );

    const future = baseReport('contract');
    future.createdAt = '2026-07-15T02:00:00.000Z';
    future.metadata.finishedAt = '2026-07-15T01:59:00.000Z';
    expect(attestEvalReport(future, options).problems).toContain(
      '报告 createdAt 位于允许时钟偏差之外的未来',
    );

    const reused = baseReport('e2e');
    reused.metadata.runtime.agentExecuted = true;
    reused.metadata.runtime.executedCaseCount = 2;
    const first = execution('a');
    const second = execution('b');
    second.requestId = first.requestId;
    second.agentExecution = first.agentExecution;
    second.missionAcceptance = first.missionAcceptance;
    reused.results = [first, second];
    expect(attestEvalReport(reused, { ...options, mode: 'e2e' }).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('跨 case 复用了 requestId'),
        expect.stringContaining('跨 case 复用了 runId'),
        expect.stringContaining('跨 case 复用了 missionId'),
      ]),
    );
  });
});
