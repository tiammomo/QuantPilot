import {
  evaluateMoAgentE2eQuality,
  summarizeE2eAgentExecution,
  type AgentExecutionResultLike,
  type MoAgentE2eQualityThresholds,
} from './e2e-attestation';

type EvalMode = 'contract' | 'e2e';
type UnknownRecord = Record<string, unknown>;

export const EVAL_REPORT_SCHEMA_VERSION = 4 as const;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface EvalReportAttestationOptions {
  mode: EvalMode;
  expectedCaseIds: string[];
  expectedCasesSha256: string;
  expectedPromptsSha256: string;
  frameworkVersion: string;
  buildRevision: string;
  gitRevision: string | null;
  qualityThresholds: MoAgentE2eQualityThresholds;
  now?: Date;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsedTime(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function duplicateStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function hasAttestableBuildRevision(value: string): boolean {
  return Boolean(value) &&
    !value.startsWith('unversioned:') &&
    !value.includes('dirty.unavailable');
}

export function attestEvalReport(
  reportValue: unknown,
  options: EvalReportAttestationOptions,
) {
  const report = record(reportValue);
  const metadata = record(report.metadata);
  const runtime = record(metadata.runtime);
  const suite = record(metadata.suite);
  const provenance = record(metadata.provenance);
  const retention = record(metadata.retention);
  const results = Array.isArray(report.results)
    ? report.results.map(record)
    : [];
  const problems: string[] = [];
  const expectedExecutionClass = options.mode === 'e2e'
    ? 'live_mission_e2e'
    : 'deterministic_contract';

  const schemaVersion = number(report.schemaVersion);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion !== EVAL_REPORT_SCHEMA_VERSION) {
    problems.push(
      `报告 schemaVersion 必须为 ${EVAL_REPORT_SCHEMA_VERSION}，实际为 ` +
      `${Number.isFinite(schemaVersion) ? schemaVersion : 'missing'}`,
    );
  }
  if (suite.mode !== options.mode) {
    problems.push(`报告模式 ${string(suite.mode) || 'unknown'} 与要求的 ${options.mode} 不一致`);
  }
  if (suite.executionClass !== expectedExecutionClass) {
    problems.push(
      `报告 executionClass 必须为 ${expectedExecutionClass}，实际为 ` +
      `${string(suite.executionClass) || 'missing'}`,
    );
  }
  if (runtime.cli !== 'moagent') {
    problems.push(`报告 runtime.cli 必须为 moagent，实际为 ${string(runtime.cli) || 'missing'}`);
  }
  if (options.mode === 'e2e' && runtime.model !== 'deepseek-v4-flash') {
    problems.push('E2E 报告 runtime.model 必须为 deepseek-v4-flash');
  }
  if (runtime.frameworkVersion !== options.frameworkVersion) {
    problems.push('报告 frameworkVersion 与当前 MoAgent 不一致');
  }
  if (runtime.buildRevision !== options.buildRevision) {
    problems.push('报告 buildRevision 与当前构建不一致');
  }
  if (options.mode === 'e2e' && !hasAttestableBuildRevision(options.buildRevision)) {
    problems.push('E2E 发布证据要求可重现的 buildRevision，拒绝 unversioned/dirty.unavailable');
  }
  const reportGitRevision = string(provenance.gitRevision || provenance.gitCommit);
  if (!options.gitRevision || reportGitRevision !== options.gitRevision) {
    problems.push('报告 git revision 与当前 checkout 不一致');
  }
  if (provenance.frameworkVersion !== options.frameworkVersion) {
    problems.push('报告 provenance.frameworkVersion 不匹配');
  }
  if (provenance.buildRevision !== options.buildRevision) {
    problems.push('报告 provenance.buildRevision 不匹配');
  }
  if (provenance.casesSha256 !== options.expectedCasesSha256) {
    problems.push('报告 casesSha256 与本次要求的 case 集不一致');
  }
  if (provenance.promptsSha256 !== options.expectedPromptsSha256) {
    problems.push('报告 promptsSha256 与当前 prompts 不一致');
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const createdAtMs = parsedTime(report.createdAt);
  const startedAtMs = parsedTime(metadata.startedAt);
  const finishedAtMs = parsedTime(metadata.finishedAt);
  if (createdAtMs === null || startedAtMs === null || finishedAtMs === null) {
    problems.push('报告缺少有效的 createdAt/startedAt/finishedAt 时间证明');
  } else {
    if (startedAtMs > finishedAtMs || finishedAtMs > createdAtMs) {
      problems.push('报告时间顺序必须满足 startedAt <= finishedAt <= createdAt');
    }
    if (createdAtMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS) {
      problems.push('报告 createdAt 位于允许时钟偏差之外的未来');
    }
  }

  const resultIds = results.map((result) => string(result.id));
  const duplicateIds = resultIds.filter((id, index) => resultIds.indexOf(id) !== index);
  if (resultIds.some((id) => !id)) problems.push('报告包含缺少 ID 的 case');
  if (duplicateIds.length > 0) {
    problems.push(`报告包含重复 case：${Array.from(new Set(duplicateIds)).join(', ')}`);
  }
  if (!sameStrings([...resultIds].sort(), [...options.expectedCaseIds].sort())) {
    problems.push(
      `报告 case 集不完整；要求 ${options.expectedCaseIds.join(', ')}，实际 ` +
      `${resultIds.join(', ') || '(empty)'}`,
    );
  }

  const calculatedPassed = results.filter((result) => result.passed === true).length;
  const calculatedFailed = results.length - calculatedPassed;
  if (number(report.total) !== results.length) problems.push('报告 total 与 results.length 不一致');
  if (number(report.passedCount) !== calculatedPassed) {
    problems.push('报告 passedCount 与逐 case 结果不一致');
  }
  if (number(report.failedCount) !== calculatedFailed) {
    problems.push('报告 failedCount 与逐 case 结果不一致');
  }

  let quality = null;
  if (options.mode === 'e2e') {
    if (
      retention.databaseEvidenceRetained !== true ||
      retention.workspaceRetained !== true
    ) {
      problems.push('E2E 报告生成时必须保留 AgentRun/Mission 数据库证据和工作空间');
    }
    if (runtime.agentExecuted !== true) {
      problems.push('E2E 报告没有真实 Agent 执行标记');
    }
    const executionSummary = summarizeE2eAgentExecution(
      results as AgentExecutionResultLike[],
    );
    if (executionSummary.unattestedCaseIds.length > 0) {
      problems.push(
        `E2E 报告包含未逐 case 证明 Mission acceptance 的用例：` +
        executionSummary.unattestedCaseIds.join(', '),
      );
    }
    if (runtime.executedCaseCount !== executionSummary.executedCaseCount) {
      problems.push('E2E runtime.executedCaseCount 与逐 case 证明不一致');
    }
    const reportedUnattested = Array.isArray(runtime.unattestedCaseIds)
      ? runtime.unattestedCaseIds.filter((value): value is string => typeof value === 'string')
      : [];
    if (!sameStrings([...reportedUnattested].sort(), [...executionSummary.unattestedCaseIds].sort())) {
      problems.push('E2E runtime.unattestedCaseIds 与逐 case 证明不一致');
    }
    const executionRecords = results.map((result) => record(result.agentExecution));
    for (const [label, values] of [
      ['requestId', results.map((result) => string(result.requestId))],
      ['missionId', executionRecords.map((execution) => string(execution.missionId))],
      ['generationId', executionRecords.map((execution) => string(execution.generationId))],
      ['acceptedReceiptId', executionRecords.map((execution) => string(execution.acceptedReceiptId))],
      [
        'acceptedReceiptHash',
        executionRecords.map((execution) => string(execution.acceptedReceiptHash)),
      ],
      [
        'runId',
        executionRecords.flatMap((execution) =>
          Array.isArray(execution.runIds) ? execution.runIds.map(string) : []),
      ],
    ] as const) {
      const duplicates = duplicateStrings(values);
      if (duplicates.length > 0) {
        problems.push(`E2E 跨 case 复用了 ${label}：${duplicates.join(', ')}`);
      }
    }
    for (const result of results as AgentExecutionResultLike[]) {
      const execution = result.agentExecution;
      if (execution?.buildRevision !== options.buildRevision) {
        problems.push(`${result.id || 'unknown'} AgentRun buildRevision 不匹配`);
      }
      if (execution?.gitRevision !== options.gitRevision) {
        problems.push(`${result.id || 'unknown'} AgentRun gitRevision 不匹配`);
      }
      if (execution?.frameworkVersion !== options.frameworkVersion) {
        problems.push(`${result.id || 'unknown'} AgentRun frameworkVersion 不匹配`);
      }
      const executionStartedAt = parsedTime(execution?.startedAt);
      const executionCompletedAt = parsedTime(execution?.completedAt);
      if (
        startedAtMs !== null &&
        finishedAtMs !== null &&
        (
          executionStartedAt === null ||
          executionCompletedAt === null ||
          executionStartedAt < startedAtMs ||
          executionCompletedAt > finishedAtMs
        )
      ) {
        problems.push(`${result.id || 'unknown'} AgentRun 时间窗口超出报告执行窗口`);
      }
    }
    quality = evaluateMoAgentE2eQuality(
      results as AgentExecutionResultLike[],
      options.qualityThresholds,
    );
    problems.push(...quality.problems);
  } else {
    if (runtime.agentExecuted === true || results.some((result) => result.agentExecuted === true)) {
      problems.push('contract 报告不得声明真实 Agent 执行');
    }
  }

  const expectedPassed = calculatedFailed === 0 && (quality?.passed ?? true) && problems.length === 0;
  if (report.passed !== expectedPassed) {
    problems.push('报告 passed 与逐 case/质量门计算结果不一致');
  }

  return {
    passed: problems.length === 0,
    problems,
    calculated: {
      total: results.length,
      passedCount: calculatedPassed,
      failedCount: calculatedFailed,
    },
    quality,
  };
}
