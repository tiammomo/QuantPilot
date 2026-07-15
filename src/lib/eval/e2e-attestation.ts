import { MOAGENT_FRAMEWORK_VERSION } from '@/lib/agent/framework-identity';

export interface AgentExecutionUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  reasoningTokens?: number;
}

export interface AgentExecutionToolsLike {
  total?: number;
  succeeded?: number;
  failed?: number;
  uncertain?: number;
  unexpectedFailureCount?: number;
  workspaceWriteSucceeded?: number;
  submitResultSucceeded?: number;
}

export interface AgentExecutionRunLike {
  id?: string;
  runInstanceId?: string;
  requestId?: string | null;
  status?: string | null;
  provider?: string | null;
  model?: string | null;
  frameworkVersion?: string | null;
  buildRevision?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  turns?: number;
  usage?: AgentExecutionUsageLike | null;
  tools?: AgentExecutionToolsLike | null;
}

export interface MissionAcceptanceLike {
  missionId?: string | null;
  generationId?: string | null;
  status?: string | null;
  candidateVersion?: number;
  acceptedReceiptId?: string | null;
  acceptedReceiptHash?: string | null;
  acceptedReceiptType?: string | null;
  acceptedReceiptVerdict?: string | null;
  acceptedSourceRunId?: string | null;
  acceptedSourceRequestId?: string | null;
  acceptedCandidateSource?: string | null;
}

export interface AgentExecutionResultLike {
  id?: string;
  requestId?: string | null;
  agentExecuted?: boolean;
  passed?: boolean;
  failures?: unknown;
  validation?: {
    status?: string | null;
    checks?: Array<{ status?: string | null }> | null;
  } | null;
  visualCheck?: { passed?: boolean } | null;
  eventAudit?: { errorCount?: number } | null;
  missionAcceptance?: MissionAcceptanceLike | null;
  agentExecution?: {
    executed?: boolean;
    cli?: string | null;
    provider?: string | null;
    model?: string | null;
    requestId?: string | null;
    runIds?: string[] | null;
    runs?: AgentExecutionRunLike[] | null;
    missionId?: string | null;
    generationId?: string | null;
    missionStatus?: string | null;
    candidateVersion?: number;
    acceptedReceiptId?: string | null;
    acceptedReceiptHash?: string | null;
    acceptedReceiptType?: string | null;
    acceptedReceiptVerdict?: string | null;
    acceptedSourceRunId?: string | null;
    acceptedSourceRequestId?: string | null;
    acceptedCandidateSource?: string | null;
    frameworkVersion?: string | null;
    buildRevision?: string | null;
    gitRevision?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    turns?: number;
    usage?: AgentExecutionUsageLike | null;
    tools?: AgentExecutionToolsLike | null;
  } | null;
}

export interface MoAgentE2eQualityThresholds {
  maxTurnsPerCase: number;
  maxCacheMissInputTokensPerCase: number;
  maxUnexpectedToolFailures: number;
}

export const DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS = Object.freeze({
  maxTurnsPerCase: 20,
  maxCacheMissInputTokensPerCase: 120_000,
  maxUnexpectedToolFailures: 0,
}) satisfies MoAgentE2eQualityThresholds;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const RECEIPT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_RUN_STATUSES = new Set([
  'candidate_complete',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]);

function validExecutionWindow(startedAt: unknown, completedAt: unknown): boolean {
  if (!nonEmptyString(startedAt) || !nonEmptyString(completedAt)) return false;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started;
}

function usagePresent(usage: AgentExecutionUsageLike | null | undefined): boolean {
  return Boolean(
    positiveInteger(usage?.inputTokens) &&
    nonNegativeInteger(usage?.outputTokens) &&
    positiveInteger(usage?.totalTokens) &&
    nonNegativeInteger(usage?.cachedInputTokens) &&
    nonNegativeInteger(usage?.cacheMissInputTokens) &&
    nonNegativeInteger(usage?.reasoningTokens) &&
    usage.cachedInputTokens + usage.cacheMissInputTokens === usage.inputTokens &&
    usage.inputTokens + usage.outputTokens === usage.totalTokens
  );
}

function toolsPresent(tools: AgentExecutionToolsLike | null | undefined): boolean {
  return Boolean(
    nonNegativeInteger(tools?.total) &&
    nonNegativeInteger(tools?.succeeded) &&
    nonNegativeInteger(tools?.failed) &&
    nonNegativeInteger(tools?.uncertain) &&
    tools.succeeded + tools.failed + tools.uncertain === tools.total &&
    nonNegativeInteger(tools?.unexpectedFailureCount) &&
    tools.unexpectedFailureCount === tools.failed + tools.uncertain &&
    nonNegativeInteger(tools?.workspaceWriteSucceeded) &&
    nonNegativeInteger(tools?.submitResultSucceeded)
  );
}

function validLineageRequest(rootRequestId: string, requestId: unknown): requestId is string {
  return nonEmptyString(requestId) && (
    requestId === rootRequestId ||
    requestId.startsWith(`${rootRequestId}-validation-repair`)
  );
}

function validRun(
  run: AgentExecutionRunLike,
  execution: NonNullable<AgentExecutionResultLike['agentExecution']>,
  rootRequestId: string,
): boolean {
  return Boolean(
    nonEmptyString(run.id) &&
    nonEmptyString(run.runInstanceId) &&
    validLineageRequest(rootRequestId, run.requestId) &&
    nonEmptyString(run.status) &&
    TERMINAL_RUN_STATUSES.has(run.status) &&
    run.provider === execution.provider &&
    run.model === execution.model &&
    run.frameworkVersion === execution.frameworkVersion &&
    run.buildRevision === execution.buildRevision &&
    validExecutionWindow(run.startedAt, run.completedAt) &&
    positiveInteger(run.turns) &&
    usagePresent(run.usage) &&
    toolsPresent(run.tools)
  );
}

function sumRuns(
  runs: readonly AgentExecutionRunLike[],
  select: (run: AgentExecutionRunLike) => number | undefined,
): number {
  return runs.reduce((total, run) => total + (select(run) ?? 0), 0);
}

function aggregateMatchesRuns(
  execution: NonNullable<AgentExecutionResultLike['agentExecution']>,
  runs: readonly AgentExecutionRunLike[],
): boolean {
  const usage = execution.usage;
  const tools = execution.tools;
  return Boolean(
    execution.turns === sumRuns(runs, (run) => run.turns) &&
    usage?.inputTokens === sumRuns(runs, (run) => run.usage?.inputTokens) &&
    usage?.outputTokens === sumRuns(runs, (run) => run.usage?.outputTokens) &&
    usage?.totalTokens === sumRuns(runs, (run) => run.usage?.totalTokens) &&
    usage?.cachedInputTokens === sumRuns(runs, (run) => run.usage?.cachedInputTokens) &&
    usage?.cacheMissInputTokens === sumRuns(
      runs,
      (run) => run.usage?.cacheMissInputTokens,
    ) &&
    usage?.reasoningTokens === sumRuns(runs, (run) => run.usage?.reasoningTokens) &&
    tools?.total === sumRuns(runs, (run) => run.tools?.total) &&
    tools?.succeeded === sumRuns(runs, (run) => run.tools?.succeeded) &&
    tools?.failed === sumRuns(runs, (run) => run.tools?.failed) &&
    tools?.uncertain === sumRuns(runs, (run) => run.tools?.uncertain) &&
    tools?.unexpectedFailureCount === sumRuns(
      runs,
      (run) => run.tools?.unexpectedFailureCount,
    ) &&
    tools?.workspaceWriteSucceeded === sumRuns(
      runs,
      (run) => run.tools?.workspaceWriteSucceeded,
    ) &&
    tools?.submitResultSucceeded === sumRuns(
      runs,
      (run) => run.tools?.submitResultSucceeded,
    )
  );
}

function missionAcceptanceMatches(result: AgentExecutionResultLike): boolean {
  const execution = result.agentExecution;
  const acceptance = result.missionAcceptance;
  if (!execution || !acceptance) return false;
  return Boolean(
    acceptance.missionId === execution?.missionId &&
    acceptance.generationId === execution.generationId &&
    acceptance.status === execution.missionStatus &&
    acceptance.candidateVersion === execution.candidateVersion &&
    acceptance.acceptedReceiptId === execution.acceptedReceiptId &&
    acceptance.acceptedReceiptHash === execution.acceptedReceiptHash &&
    acceptance.acceptedReceiptType === execution.acceptedReceiptType &&
    acceptance.acceptedReceiptVerdict === execution.acceptedReceiptVerdict &&
    acceptance.acceptedSourceRunId === execution.acceptedSourceRunId &&
    acceptance.acceptedSourceRequestId === execution.acceptedSourceRequestId &&
    acceptance.acceptedCandidateSource === execution.acceptedCandidateSource
  );
}

function resultEvidenceConsistent(result: AgentExecutionResultLike): boolean {
  const checks = result.validation?.checks;
  return Boolean(
    result.passed === true &&
    Array.isArray(result.failures) &&
    result.failures.length === 0 &&
    result.validation?.status === 'passed' &&
    Array.isArray(checks) &&
    checks.length > 0 &&
    checks.every((check) => check.status !== 'failed') &&
    (result.visualCheck == null || result.visualCheck.passed === true) &&
    (result.eventAudit == null || result.eventAudit.errorCount === 0) &&
    missionAcceptanceMatches(result)
  );
}

function executionMetricsPresent(result: AgentExecutionResultLike): boolean {
  const execution = result.agentExecution;
  const runs = execution?.runs;
  if (
    !execution ||
    !nonEmptyString(execution.requestId) ||
    !Array.isArray(runs) ||
    runs.length === 0 ||
    !positiveInteger(execution.turns) ||
    !usagePresent(execution.usage) ||
    !toolsPresent(execution.tools)
  ) {
    return false;
  }
  const runIds = runs.map((run) => run.id);
  const acceptedRun = runs.find((run) => run.id === execution.acceptedSourceRunId);
  return Boolean(
    runs.every((run) => validRun(run, execution, execution.requestId!)) &&
    new Set(runIds).size === runIds.length &&
    Array.isArray(execution.runIds) &&
    execution.runIds.length === runIds.length &&
    execution.runIds.every((runId, index) => runId === runIds[index]) &&
    aggregateMatchesRuns(execution, runs) &&
    acceptedRun?.status === 'candidate_complete' &&
    acceptedRun.requestId === execution.acceptedSourceRequestId &&
    positiveInteger(acceptedRun.tools?.workspaceWriteSucceeded) &&
    positiveInteger(acceptedRun.tools?.submitResultSucceeded)
  );
}

export function isE2eAgentExecutionAttested(result: AgentExecutionResultLike): boolean {
  const execution = result.agentExecution;
  return Boolean(
    result.agentExecuted === true &&
    execution?.executed === true &&
    execution.cli === 'moagent' &&
    execution.provider === 'deepseek' &&
    execution.model === 'deepseek-v4-flash' &&
    nonEmptyString(execution.requestId) &&
    result.requestId === execution.requestId &&
    Array.isArray(execution.runIds) &&
    execution.runIds.length > 0 &&
    execution.runIds.every(nonEmptyString) &&
    nonEmptyString(execution.missionId) &&
    nonEmptyString(execution.generationId) &&
    execution.missionStatus === 'completed' &&
    positiveInteger(execution.candidateVersion) &&
    nonEmptyString(execution.acceptedReceiptId) &&
    nonEmptyString(execution.acceptedReceiptHash) &&
    RECEIPT_HASH_PATTERN.test(execution.acceptedReceiptHash) &&
    execution.acceptedReceiptType === 'acceptance' &&
    execution.acceptedReceiptVerdict === 'accepted' &&
    nonEmptyString(execution.acceptedSourceRunId) &&
    nonEmptyString(execution.acceptedSourceRequestId) &&
    execution.acceptedCandidateSource === 'moagent_submit_result' &&
    execution.frameworkVersion === MOAGENT_FRAMEWORK_VERSION &&
    nonEmptyString(execution.buildRevision) &&
    nonEmptyString(execution.gitRevision) &&
    validExecutionWindow(execution.startedAt, execution.completedAt) &&
    executionMetricsPresent(result) &&
    resultEvidenceConsistent(result)
  );
}

export function summarizeE2eAgentExecution(results: AgentExecutionResultLike[]) {
  const unattestedCaseIds = results
    .filter((result) => !isE2eAgentExecutionAttested(result))
    .map((result) => result.id || 'unknown');
  return {
    agentExecuted: results.length > 0 && unattestedCaseIds.length === 0,
    executedCaseCount: results.length - unattestedCaseIds.length,
    unattestedCaseIds,
  };
}

export function summarizeMoAgentE2eQuality(results: AgentExecutionResultLike[]) {
  const measured = results.filter(executionMetricsPresent);
  const missingMetricsCaseIds = results
    .filter((result) => !executionMetricsPresent(result))
    .map((result) => result.id || 'unknown');
  const value = (
    result: AgentExecutionResultLike,
    select: (execution: NonNullable<AgentExecutionResultLike['agentExecution']>) => number,
  ) => select(result.agentExecution!);
  const turns = measured.map((result) => ({
    id: result.id || 'unknown',
    value: value(result, (execution) => execution.turns!),
  }));
  const cacheMiss = measured.map((result) => ({
    id: result.id || 'unknown',
    value: value(result, (execution) => execution.usage!.cacheMissInputTokens!),
  }));
  const unexpectedFailures = measured.map((result) => ({
    id: result.id || 'unknown',
    value: value(result, (execution) => execution.tools!.unexpectedFailureCount!),
  }));
  const total = (items: Array<{ value: number }>) =>
    items.reduce((sum, item) => sum + item.value, 0);
  const max = (items: Array<{ id: string; value: number }>) =>
    items.reduce<{ id: string | null; value: number }>(
      (current, item) => item.value > current.value ? item : current,
      { id: null, value: 0 },
    );
  const totalTurns = total(turns);
  const totalCacheMissInputTokens = total(cacheMiss);
  const unexpectedToolFailureCount = total(unexpectedFailures);

  return {
    caseCount: results.length,
    measuredCaseCount: measured.length,
    missingMetricsCaseIds,
    turns: {
      total: totalTurns,
      average: measured.length ? Math.round(totalTurns / measured.length) : 0,
      max: max(turns),
    },
    cacheMissInputTokens: {
      total: totalCacheMissInputTokens,
      average: measured.length
        ? Math.round(totalCacheMissInputTokens / measured.length)
        : 0,
      max: max(cacheMiss),
    },
    tools: {
      unexpectedFailureCount: unexpectedToolFailureCount,
      affectedCaseIds: unexpectedFailures
        .filter((item) => item.value > 0)
        .map((item) => item.id),
    },
  };
}

export function evaluateMoAgentE2eQuality(
  results: AgentExecutionResultLike[],
  thresholds: MoAgentE2eQualityThresholds,
) {
  const summary = summarizeMoAgentE2eQuality(results);
  const problems: string[] = [];
  if (summary.missingMetricsCaseIds.length > 0) {
    problems.push(
      `E2E 用例缺少真实运行指标：${summary.missingMetricsCaseIds.join(', ')}`,
    );
  }
  for (const result of results) {
    if (!executionMetricsPresent(result)) continue;
    const caseId = result.id || 'unknown';
    const turns = result.agentExecution!.turns!;
    const cacheMissInputTokens = result.agentExecution!.usage!.cacheMissInputTokens!;
    if (turns > thresholds.maxTurnsPerCase) {
      problems.push(
        `${caseId} turns=${turns} 超过阈值 ${thresholds.maxTurnsPerCase}`,
      );
    }
    if (cacheMissInputTokens > thresholds.maxCacheMissInputTokensPerCase) {
      problems.push(
        `${caseId} cache-miss input tokens=${cacheMissInputTokens} 超过阈值 ` +
        `${thresholds.maxCacheMissInputTokensPerCase}`,
      );
    }
  }
  if (summary.tools.unexpectedFailureCount > thresholds.maxUnexpectedToolFailures) {
    problems.push(
      `unexpected tool failures=${summary.tools.unexpectedFailureCount} 超过阈值 ` +
      `${thresholds.maxUnexpectedToolFailures}`,
    );
  }
  return { passed: problems.length === 0, problems, summary, thresholds };
}
