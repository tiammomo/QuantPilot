import {
  evaluateMoAgentE2eQuality,
  isE2eAgentExecutionAttested,
  summarizeE2eAgentExecution,
  type AgentExecutionResultLike,
  type E2eAgentExpectedRuntime,
  type MoAgentE2eQualityThresholds,
} from './e2e-attestation';
import { LOCAL_QWEN_MODEL_ID } from '@/lib/constants/models';
import { isCurrentEvaluation } from './evaluators';
import { buildEvalQualitySummary } from './scoring';
import { buildEvalTraceDiagnostics } from './trace-diagnostics';

type EvalMode = 'contract' | 'e2e';
type UnknownRecord = Record<string, unknown>;

export const EVAL_REPORT_SCHEMA_VERSION = 6 as const;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface EvalReportAttestationOptions {
  mode: EvalMode;
  expectedCaseIds: string[];
  expectedCasesSha256: string;
  expectedPromptsSha256: string;
  expectedDatasetRegistrySha256: string;
  expectedSnapshotManifestSha256: string;
  expectedDataSnapshots: Array<{
    caseId: string;
    id: string;
    asOf: string;
    payloadSha256: string;
  }>;
  expectedDatasetVisibility: 'public' | 'hidden' | 'production_replay';
  expectedRuntimeProvider?: E2eAgentExpectedRuntime['provider'];
  expectedRuntimeModel?: string;
  expectedResultQuestions: Record<string, string>;
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
  const evaluator = record(metadata.evaluator);
  const selection = record(metadata.selection);
  const dataset = record(metadata.dataset);
  const results = Array.isArray(report.results)
    ? report.results.map(record)
    : [];
  const problems: string[] = [];
  const expectedExecutionClass = options.mode === 'e2e'
    ? 'live_mission_e2e'
    : 'deterministic_contract';
  const expectedRuntime: E2eAgentExpectedRuntime = {
    provider: options.expectedRuntimeProvider ?? 'openai',
    model: options.expectedRuntimeModel ?? LOCAL_QWEN_MODEL_ID,
  };

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
  if (dataset.schemaVersion !== 1 || dataset.visibility !== options.expectedDatasetVisibility) {
    problems.push('报告 dataset visibility 与本次要求不一致');
  }
  if (dataset.promptsRedacted !== (options.expectedDatasetVisibility !== 'public')) {
    problems.push('报告 dataset promptsRedacted 标记不正确');
  }
  if (options.expectedDatasetVisibility !== 'public') {
    const command = Array.isArray(metadata.command) ? metadata.command.map(string) : [];
    for (let index = 0; index < command.length; index += 1) {
      const arg = command[index];
      if (arg === '--cases-file' && command[index + 1] !== '[external-dataset]') {
        problems.push('非公开报告 command 泄漏了外部 cases file 路径');
      }
      if (arg.startsWith('--cases-file=') && arg !== '--cases-file=[external-dataset]') {
        problems.push('非公开报告 command 泄漏了外部 cases file 路径');
      }
    }
  }
  if (runtime.cli !== 'moagent') {
    problems.push(`报告 runtime.cli 必须为 moagent，实际为 ${string(runtime.cli) || 'missing'}`);
  }
  if (!string(evaluator.id) || !string(evaluator.version) || !string(evaluator.rubricVersion)) {
    problems.push('报告缺少 evaluator id/version/rubricVersion');
  }
  const repeat = number(selection.repeat);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 5) {
    problems.push('报告 selection.repeat 必须为 1 到 5 的整数');
  }
  if (options.mode === 'e2e' && runtime.model !== expectedRuntime.model) {
    problems.push(`E2E 报告 runtime.model 必须为 ${expectedRuntime.model}`);
  }
  if (options.mode === 'e2e' && runtime.provider !== expectedRuntime.provider) {
    problems.push(`E2E 报告 runtime.provider 必须为 ${expectedRuntime.provider}`);
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
  if (provenance.datasetRegistrySha256 !== options.expectedDatasetRegistrySha256) {
    problems.push('报告 datasetRegistrySha256 与当前数据集合同不一致');
  }
  if (provenance.snapshotManifestSha256 !== options.expectedSnapshotManifestSha256) {
    problems.push('报告 snapshotManifestSha256 与当前快照合同不一致');
  }
  const dataSnapshots = record(metadata.dataSnapshots);
  const selectedSnapshots = Array.isArray(dataSnapshots.selected) ? dataSnapshots.selected.map(record) : [];
  const normalizedSnapshots = selectedSnapshots.map((item) => ({
    caseId: string(item.caseId),
    id: string(item.id),
    asOf: string(item.asOf),
    payloadSha256: string(item.payloadSha256),
  }));
  const expectedSnapshots = [...options.expectedDataSnapshots].sort((left, right) => left.caseId.localeCompare(right.caseId));
  normalizedSnapshots.sort((left, right) => left.caseId.localeCompare(right.caseId));
  if (dataSnapshots.schemaVersion !== 1 || JSON.stringify(normalizedSnapshots) !== JSON.stringify(expectedSnapshots)) {
    problems.push('报告 dataSnapshots 与本次 case 对应的可重放快照不一致');
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
  const repeatedE2eEvidence: Array<{
    caseId: string;
    attempt: number;
    evidence: UnknownRecord;
  }> = [];
  for (const result of results) {
    const caseId = string(result.id) || 'unknown';
    if (Object.hasOwn(options.expectedResultQuestions, caseId) &&
      string(result.question) !== options.expectedResultQuestions[caseId]) {
      problems.push(`${caseId} question 证据未按数据集可见性保存`);
    }
    const evaluation = record(result.evaluation);
    if (!isCurrentEvaluation(evaluation)) {
      problems.push(`${caseId} 缺少当前版本的 evaluator 结果`);
    }
    if (evaluation.evaluatorId !== evaluator.id ||
      evaluation.evaluatorVersion !== evaluator.version ||
      evaluation.rubricVersion !== evaluator.rubricVersion) {
      problems.push(`${caseId} evaluator 身份与报告 metadata 不一致`);
    }
    if (typeof result.firstPassPassed !== 'boolean' || typeof result.finalPassed !== 'boolean') {
      problems.push(`${caseId} 缺少 firstPassPassed/finalPassed`);
    }
    if (result.finalPassed !== result.passed || evaluation.passed !== result.passed) {
      problems.push(`${caseId} final/evaluator/pass 判定不一致`);
    }
    if (number(result.score) !== number(evaluation.score)) {
      problems.push(`${caseId} score 与 evaluator score 不一致`);
    }
    const reportedTrace = record(result.traceDiagnostics);
    const expectedTrace = buildEvalTraceDiagnostics(result, options.mode);
    if (JSON.stringify(reportedTrace) !== JSON.stringify(expectedTrace)) {
      problems.push(`${caseId} traceDiagnostics 与可观察证据重算结果不一致`);
    }
    const stability = record(result.stability);
    const attempts = Array.isArray(stability.attempts) ? stability.attempts.map(record) : [];
    if (number(stability.repeatCount) !== repeat || attempts.length !== repeat) {
      problems.push(`${caseId} stability attempts 与 selection.repeat 不一致`);
    }
    const passedAttempts = attempts.filter((attempt) => attempt.passed === true).length;
    const expectedStabilityRate = attempts.length > 0
      ? Math.round((passedAttempts / attempts.length) * 100)
      : 0;
    if (number(stability.passedAttempts) !== passedAttempts ||
      number(stability.passRate) !== expectedStabilityRate ||
      stability.passed !== (passedAttempts === attempts.length) ||
      stability.flaky !== (passedAttempts > 0 && passedAttempts < attempts.length)) {
      problems.push(`${caseId} stability 汇总与逐次结果不一致`);
    }
    const attemptNumbers = attempts.map((attempt) => number(attempt.attempt));
    const expectedAttemptNumbers = Number.isSafeInteger(repeat)
      ? Array.from({ length: repeat }, (_, index) => index + 1)
      : [];
    if (!sameStrings(attemptNumbers.map(String), expectedAttemptNumbers.map(String))) {
      problems.push(`${caseId} stability attempt 序号必须从 1 连续递增`);
    }
    for (const attempt of attempts) {
      const durationMs = number(attempt.durationMs);
      const repairAttempts = number(attempt.repairAttempts);
      if (
        typeof attempt.passed !== 'boolean' ||
        typeof attempt.firstPassPassed !== 'boolean' ||
        !Number.isFinite(number(attempt.score)) ||
        !Number.isFinite(durationMs) ||
        !Number.isFinite(repairAttempts) ||
        durationMs < 0 ||
        repairAttempts < 0 ||
        (attempt.firstPassPassed === true && attempt.passed !== true)
      ) {
        problems.push(`${caseId} 第 ${number(attempt.attempt)} 次 stability 指标无效`);
      }
    }
    const primaryAttempt = attempts[0];
    if (primaryAttempt && (
      primaryAttempt.passed !== result.passed ||
      primaryAttempt.firstPassPassed !== result.firstPassPassed ||
      number(primaryAttempt.score) !== number(result.score)
    )) {
      problems.push(`${caseId} 顶层结果与首个物理 run 不一致`);
    }
    if (options.mode === 'e2e') {
      for (const attempt of attempts) {
        const evidence = record(attempt.evidence);
        if (!isE2eAgentExecutionAttested(
          evidence as AgentExecutionResultLike,
          expectedRuntime,
        )) {
          problems.push(`${caseId} 第 ${number(attempt.attempt)} 次运行缺少可验真的 E2E 证据`);
        }
        if (attempt.agentAttested !== true) {
          problems.push(`${caseId} 第 ${number(attempt.attempt)} 次运行 agentAttested 必须为 true`);
        }
        if (
          string(attempt.requestId) !== string(evidence.requestId) ||
          string(attempt.projectId) !== string(evidence.projectId) ||
          string(attempt.projectPath) !== string(evidence.projectPath)
        ) {
          problems.push(`${caseId} 第 ${number(attempt.attempt)} 次运行身份摘要与 E2E 证据不一致`);
        }
        repeatedE2eEvidence.push({
          caseId,
          attempt: number(attempt.attempt),
          evidence,
        });
      }
    }
  }
  const expectedQualitySummary = buildEvalQualitySummary(results, Number.isSafeInteger(repeat) ? repeat : 1);
  const reportedQualitySummary = record(report.qualitySummary);
  for (const key of [
    'caseCount',
    'firstPassCount',
    'finalPassCount',
    'firstPassRate',
    'finalPassRate',
    'repairedCaseCount',
    'repairRate',
    'averageScore',
  ] as const) {
    if (number(reportedQualitySummary[key]) !== expectedQualitySummary[key]) {
      problems.push(`报告 qualitySummary.${key} 与逐 case 重算不一致`);
    }
  }
  const reportedDuration = record(reportedQualitySummary.durationMs);
  for (const key of ['total', 'average', 'p50', 'p95'] as const) {
    if (number(reportedDuration[key]) !== expectedQualitySummary.durationMs[key]) {
      problems.push(`报告 qualitySummary.durationMs.${key} 与逐 case 重算不一致`);
    }
  }
  const reportedDimensions = record(reportedQualitySummary.dimensions);
  for (const [dimensionId, score] of Object.entries(expectedQualitySummary.dimensions)) {
    if (number(reportedDimensions[dimensionId]) !== score) {
      problems.push(`报告 qualitySummary.dimensions.${dimensionId} 与逐 case 重算不一致`);
    }
  }
  const reportedStability = record(reportedQualitySummary.stability);
  for (const key of ['repeatCount', 'attemptCount', 'passedAttemptCount', 'passRate'] as const) {
    if (number(reportedStability[key]) !== expectedQualitySummary.stability[key]) {
      problems.push(`报告 qualitySummary.stability.${key} 与逐次结果不一致`);
    }
  }
  const reportedFlakyCaseIds = Array.isArray(reportedStability.flakyCaseIds)
    ? reportedStability.flakyCaseIds.filter((value): value is string => typeof value === 'string')
    : [];
  if (!sameStrings(
    [...reportedFlakyCaseIds].sort(),
    [...expectedQualitySummary.stability.flakyCaseIds].sort(),
  )) {
    problems.push('报告 qualitySummary.stability.flakyCaseIds 与逐次结果不一致');
  }
  const reportedConfidence = record(reportedStability.confidence95);
  for (const key of ['lower', 'upper'] as const) {
    if (number(reportedConfidence[key]) !== expectedQualitySummary.stability.confidence95[key]) {
      problems.push(`报告 qualitySummary.stability.confidence95.${key} 与逐次结果不一致`);
    }
  }
  const reportedScoreStdDev = record(reportedStability.scoreStdDev);
  const reportedMaxScoreStdDev = record(reportedScoreStdDev.max);
  if (number(reportedScoreStdDev.average) !== expectedQualitySummary.stability.scoreStdDev.average ||
    number(reportedMaxScoreStdDev.value) !== expectedQualitySummary.stability.scoreStdDev.max.value ||
    (reportedMaxScoreStdDev.id ?? null) !== expectedQualitySummary.stability.scoreStdDev.max.id) {
    problems.push('报告 qualitySummary.stability.scoreStdDev 与逐次分数重算不一致');
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
      expectedRuntime,
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
    const repeatedExecutions = repeatedE2eEvidence.map((item) => ({
      ...item,
      execution: record(item.evidence.agentExecution),
    }));
    for (const [label, values] of [
      ['requestId', repeatedExecutions.map((item) => string(item.evidence.requestId))],
      ['missionId', repeatedExecutions.map((item) => string(item.execution.missionId))],
      ['generationId', repeatedExecutions.map((item) => string(item.execution.generationId))],
      ['acceptedReceiptId', repeatedExecutions.map((item) => string(item.execution.acceptedReceiptId))],
      ['acceptedReceiptHash', repeatedExecutions.map((item) => string(item.execution.acceptedReceiptHash))],
      [
        'runId',
        repeatedExecutions.flatMap((item) =>
          Array.isArray(item.execution.runIds) ? item.execution.runIds.map(string) : []),
      ],
    ] as const) {
      const duplicates = duplicateStrings(values);
      if (duplicates.length > 0) {
        problems.push(`E2E 物理重复运行复用了 ${label}：${duplicates.join(', ')}`);
      }
    }
    for (const item of repeatedExecutions) {
      const execution = item.evidence.agentExecution as AgentExecutionResultLike['agentExecution'];
      if (
        execution?.buildRevision !== options.buildRevision ||
        execution?.gitRevision !== options.gitRevision ||
        execution?.frameworkVersion !== options.frameworkVersion
      ) {
        problems.push(`${item.caseId} 第 ${item.attempt} 次 AgentRun 运行版本不匹配`);
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
        problems.push(`${item.caseId} 第 ${item.attempt} 次 AgentRun 时间窗口超出报告执行窗口`);
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

  const expectedPassed = calculatedFailed === 0 &&
    expectedQualitySummary.stability.passRate === 100 &&
    (quality?.passed ?? true) &&
    problems.length === 0;
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
