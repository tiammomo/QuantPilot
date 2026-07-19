import { describe, expect, it } from 'vitest';

import { applyEvalEvaluator, getEvalEvaluatorDefinition } from './evaluators';
import { attestEvalReport, type EvalReportAttestationOptions } from './report-attestation';
import { buildEvalQualitySummary } from './scoring';
import { buildEvalTraceDiagnostics } from './trace-diagnostics';

const GIT = 'a'.repeat(40);
const options: EvalReportAttestationOptions = {
  mode: 'contract',
  expectedCaseIds: ['a', 'b'],
  expectedCasesSha256: 'cases-hash',
  expectedPromptsSha256: 'prompts-hash',
  expectedDatasetRegistrySha256: 'dataset-registry-hash',
  expectedSnapshotManifestSha256: 'snapshot-manifest-hash',
  expectedDataSnapshots: [],
  expectedDatasetVisibility: 'public',
  expectedResultQuestions: {},
  frameworkVersion: 'moagent:1.8.0',
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
  const results = ['a', 'b'].map((id) => finalizeResult({ id, passed: true, failures: [], agentExecuted: false }, mode));
  const evaluator = getEvalEvaluatorDefinition('rule-strict');
  return {
    schemaVersion: 6,
    createdAt: '2026-07-15T00:02:00.000Z',
    passed: true,
    total: 2,
    passedCount: 2,
    failedCount: 0,
    metadata: {
      runtime: {
        cli: 'moagent',
        provider: mode === 'e2e' ? 'openai' : null,
        model: mode === 'e2e' ? 'local_qwen:qwen3.5-9b-q5km' : null,
        frameworkVersion: 'moagent:1.8.0',
        buildRevision: 'build-current',
        agentExecuted: false,
        executedCaseCount: 0,
        unattestedCaseIds: [],
      },
      evaluator: {
        id: evaluator.id,
        version: evaluator.version,
        rubricVersion: evaluator.rubricVersion,
        concurrency: 1,
      },
      selection: { repeat: 1 },
      startedAt: '2026-07-15T00:00:00.000Z',
      finishedAt: '2026-07-15T00:01:30.000Z',
      suite: {
        mode,
        executionClass: mode === 'e2e' ? 'live_mission_e2e' : 'deterministic_contract',
      },
      dataset: { schemaVersion: 1, visibility: 'public', promptsRedacted: false },
      retention: {
        databaseEvidenceRetained: mode === 'e2e',
        workspaceRetained: mode === 'e2e',
      },
      provenance: {
        gitRevision: GIT,
        frameworkVersion: 'moagent:1.8.0',
        buildRevision: 'build-current',
        casesSha256: 'cases-hash',
        promptsSha256: 'prompts-hash',
        datasetRegistrySha256: 'dataset-registry-hash',
        snapshotManifestSha256: 'snapshot-manifest-hash',
      },
      dataSnapshots: { schemaVersion: 1, selected: [] },
    },
    qualitySummary: buildEvalQualitySummary(results, 1),
    results,
  };
}

function finalizeResult<T extends Record<string, unknown>>(result: T, mode: 'contract' | 'e2e') {
  const withTrace = { ...result, traceDiagnostics: buildEvalTraceDiagnostics(result, mode) };
  const evaluation = applyEvalEvaluator({ evaluatorId: 'rule-strict', mode, result: withTrace });
  const enriched = {
    ...withTrace,
    passed: evaluation.passed,
    firstPassPassed: evaluation.passed,
    finalPassed: evaluation.passed,
    score: evaluation.score,
    evaluation,
  };
  return {
    ...enriched,
    stability: {
      passed: evaluation.passed,
      repeatCount: 1,
      passedAttempts: evaluation.passed ? 1 : 0,
      passRate: evaluation.passed ? 100 : 0,
      flaky: false,
      attempts: [{
        attempt: 1,
        passed: evaluation.passed,
        firstPassPassed: evaluation.passed,
        score: evaluation.score,
        durationMs: 0,
        repairAttempts: 0,
        projectId: null,
        projectPath: null,
        requestId: typeof result.requestId === 'string' ? result.requestId : null,
        failures: [],
        agentAttested: mode === 'e2e',
        evidence: mode === 'e2e' ? enriched : undefined,
      }],
    },
  };
}

function replaceResults<T extends ReturnType<typeof baseReport>>(report: T, results: unknown[]) {
  report.results = results as T['results'];
  report.total = results.length;
  report.passedCount = results.filter((result) => (result as { passed?: boolean }).passed).length;
  report.failedCount = results.length - report.passedCount;
  report.qualitySummary = buildEvalQualitySummary(results, 1);
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
  return finalizeResult({
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
      provider: 'openai',
      model: 'local_qwen:qwen3.5-9b-q5km',
      requestId,
      runIds: [runId],
      runs: [{
        id: runId,
        runInstanceId: `instance-${id}`,
        requestId,
        status: 'candidate_complete',
        provider: 'openai',
        model: 'local_qwen:qwen3.5-9b-q5km',
        frameworkVersion: 'moagent:1.8.0',
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
      frameworkVersion: 'moagent:1.8.0',
      buildRevision: 'build-current',
      gitRevision: GIT,
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:01:00.000Z',
      turns: 5,
      usage,
      tools,
    },
  }, 'e2e');
}

describe('eval report attestation', () => {
  it('accepts a complete current-build deterministic contract report', () => {
    expect(attestEvalReport(baseReport('contract'), options)).toMatchObject({
      passed: true,
      problems: [],
    });
  });

  it('attests an internally consistent report that fails only the repeat stability gate', () => {
    const report = baseReport('contract');
    report.metadata.selection.repeat = 2;
    for (const result of report.results) {
      const first = result.stability.attempts[0];
      result.stability = {
        passed: true,
        repeatCount: 2,
        passedAttempts: 2,
        passRate: 100,
        flaky: false,
        attempts: [first, { ...first, attempt: 2 }],
      };
    }
    const firstResult = report.results[0];
    firstResult.stability.attempts[1] = {
      ...firstResult.stability.attempts[1],
      passed: false,
      firstPassPassed: false,
    };
    firstResult.stability = {
      ...firstResult.stability,
      passed: false,
      passedAttempts: 1,
      passRate: 50,
      flaky: true,
    };
    report.qualitySummary = buildEvalQualitySummary(report.results, 2);
    report.passed = false;

    expect(attestEvalReport(report, options)).toMatchObject({
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

  it('binds a report to the selected data snapshots', () => {
    const report = baseReport('contract');
    const expectedDataSnapshots = [{
      caseId: 'a',
      id: 'a-snapshot-v1',
      asOf: '2026-07-15T00:00:00.000Z',
      payloadSha256: 'c'.repeat(64),
    }];
    (report.metadata.dataSnapshots.selected as unknown[]) = structuredClone(expectedDataSnapshots);
    expect(attestEvalReport(report, { ...options, expectedDataSnapshots })).toMatchObject({
      passed: true,
      problems: [],
    });

    (report.metadata.dataSnapshots.selected[0] as unknown as { payloadSha256: string }).payloadSha256 = 'd'.repeat(64);
    expect(attestEvalReport(report, { ...options, expectedDataSnapshots }).problems).toContain(
      '报告 dataSnapshots 与本次 case 对应的可重放快照不一致',
    );
  });

  it('accepts only Mission-backed E2E metrics and applies efficiency thresholds', () => {
    const report = baseReport('e2e');
    report.metadata.runtime.agentExecuted = true;
    report.metadata.runtime.executedCaseCount = 2;
    const secondExecution = execution('b');
    replaceResults(report, [execution('a'), secondExecution]);
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

  it('accepts a registered non-default runtime only when the gate expects it', () => {
    const report = baseReport('e2e');
    report.metadata.runtime.provider = 'deepseek';
    report.metadata.runtime.model = 'deepseek-v4-flash';
    report.metadata.runtime.agentExecuted = true;
    report.metadata.runtime.executedCaseCount = 2;
    const executions = [execution('a'), execution('b')];
    for (const result of executions) {
      result.agentExecution.provider = 'deepseek';
      result.agentExecution.model = 'deepseek-v4-flash';
      result.agentExecution.runs[0].provider = 'deepseek';
      result.agentExecution.runs[0].model = 'deepseek-v4-flash';
    }
    replaceResults(report, executions);

    expect(attestEvalReport(report, {
      ...options,
      mode: 'e2e',
      expectedRuntimeProvider: 'deepseek',
      expectedRuntimeModel: 'deepseek-v4-flash',
    })).toMatchObject({ passed: true, problems: [] });
    expect(attestEvalReport(report, { ...options, mode: 'e2e' }).problems).toEqual(
      expect.arrayContaining([
        'E2E 报告 runtime.model 必须为 local_qwen:qwen3.5-9b-q5km',
        'E2E 报告 runtime.provider 必须为 openai',
      ]),
    );
  });

  it.each([
    'unversioned:moagent:1.8.0',
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
    replaceResults(report, executions);

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
      '报告 schemaVersion 必须为 6，实际为 missing',
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
    replaceResults(reused, [first, second]);
    expect(attestEvalReport(reused, { ...options, mode: 'e2e' }).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('跨 case 复用了 requestId'),
        expect.stringContaining('跨 case 复用了 runId'),
        expect.stringContaining('跨 case 复用了 missionId'),
      ]),
    );
  });

  it('rejects identity reuse across repeated physical E2E runs', () => {
    const report = baseReport('e2e');
    report.metadata.runtime.agentExecuted = true;
    report.metadata.runtime.executedCaseCount = 2;
    report.metadata.selection.repeat = 2;
    replaceResults(report, [execution('a'), execution('b')]);
    for (const result of report.results) {
      const first = result.stability.attempts[0];
      result.stability = {
        passed: true,
        repeatCount: 2,
        passedAttempts: 2,
        passRate: 100,
        flaky: false,
        attempts: [first, { ...structuredClone(first), attempt: 2 }],
      };
    }
    report.qualitySummary = buildEvalQualitySummary(report.results, 2);

    expect(attestEvalReport(report, { ...options, mode: 'e2e' }).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('物理重复运行复用了 requestId'),
        expect.stringContaining('物理重复运行复用了 runId'),
        expect.stringContaining('物理重复运行复用了 missionId'),
      ]),
    );
  });
});
