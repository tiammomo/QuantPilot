import path from 'node:path';
import {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_EVALUATOR_ID,
  EVAL_CAPABILITY_LABELS,
  EVAL_TYPE_LABELS,
  MAX_EVAL_CONCURRENCY,
} from './constants';
import { ROOT } from './paths';
import {
  EVAL_SCORE_DIMENSION_IDS,
  buildEvalQualitySummary,
  resultScore,
  type EvalScoreDimensionId,
} from './scoring';
import type {
  EvalCheckStatus,
  QuantEvalArtifactSummary,
  QuantEvalCase,
  QuantEvalCheck,
  QuantEvalQueueItem,
  QuantEvalQueueStatus,
  QuantEvalRepairTicket,
  QuantEvalResult,
  QuantEvalRun,
  QuantEvalScheduleConfig,
} from './types';
import {
  booleanValue,
  isRecord,
  numberValue,
  readJson,
  readRecordArray,
  stringArray,
  stringValue,
  type JsonRecord,
} from './runtime-utils';

function normalizeEvalConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EVAL_CONCURRENCY;
  }
  return Math.min(MAX_EVAL_CONCURRENCY, Math.max(1, Math.floor(value)));
}

export function normalizeSkillLockSnapshot(value: unknown): QuantEvalRun['metadata']['skillLockSnapshot'] {
  const snapshot = isRecord(value) ? value : {};
  const skillsRaw = isRecord(snapshot.skills) ? snapshot.skills : {};
  const skills = Object.fromEntries(
    Object.entries(skillsRaw).map(([skillId, entry]) => {
      const item = isRecord(entry) ? entry : {};
      return [
        skillId,
        {
          version: stringValue(item.version) || null,
          hash: stringValue(item.hash) || stringValue(item.sourceSha256) || null,
          packageHash: stringValue(item.packageHash) || stringValue(item.packageSha256) || null,
          sourceSha256: stringValue(item.sourceSha256) || stringValue(item.hash) || null,
          packageSha256: stringValue(item.packageSha256) || stringValue(item.packageHash) || null,
          sourcePath: stringValue(item.sourcePath) || null,
          packagePath: stringValue(item.packagePath) || null,
        },
      ];
    })
  );

  const schemaVersion =
    typeof snapshot.schemaVersion === 'string' || typeof snapshot.schemaVersion === 'number'
      ? snapshot.schemaVersion
      : null;

  return {
    schemaVersion,
    skills,
  };
}

export async function readCurrentSkillLockSnapshot(): Promise<QuantEvalRun['metadata']['skillLockSnapshot']> {
  const lockPath = path.join(ROOT, '.moagent', 'skills.lock.json');
  const parsed = await readJson(lockPath).catch(() => null);
  return normalizeSkillLockSnapshot(parsed);
}

export function normalizeMetadata(report: JsonRecord, results: QuantEvalResult[]): QuantEvalRun['metadata'] {
  const metadata = isRecord(report.metadata) ? report.metadata : {};
  const runtime = isRecord(metadata.runtime) ? metadata.runtime : {};
  const selection = isRecord(metadata.selection) ? metadata.selection : {};
  const evaluator = isRecord(metadata.evaluator) ? metadata.evaluator : {};
  const suite = isRecord(metadata.suite) ? metadata.suite : {};
  const dataset = isRecord(metadata.dataset) ? metadata.dataset : {};
  const provenance = isRecord(metadata.provenance) ? metadata.provenance : {};
  const retention = isRecord(metadata.retention) ? metadata.retention : {};
  const dataSnapshots = isRecord(metadata.dataSnapshots) ? metadata.dataSnapshots : {};
  const concurrency = normalizeEvalConcurrency(selection.concurrency ?? evaluator.concurrency);

  return {
    trigger: stringValue(metadata.trigger) || null,
    reportSchemaVersion: Number.isSafeInteger(report.schemaVersion)
      ? numberValue(report.schemaVersion)
      : null,
    startedAt: stringValue(metadata.startedAt) || stringValue(report.createdAt) || null,
    finishedAt: stringValue(metadata.finishedAt) || stringValue(report.createdAt) || null,
    command: stringArray(metadata.command),
    evaluator: {
      id: stringValue(evaluator.id) || null,
      version: stringValue(evaluator.version) || null,
      rubricVersion: stringValue(evaluator.rubricVersion) || null,
      concurrency,
    },
    runtime: {
      cli: stringValue(runtime.cli) || 'benchmark',
      model: stringValue(runtime.model) || 'deterministic',
      reasoningEffort: stringValue(runtime.reasoningEffort) || null,
      configuredModel: stringValue(runtime.configuredModel) || null,
      agentExecuted: booleanValue(runtime.agentExecuted),
      executedCaseCount: numberValue(runtime.executedCaseCount),
      unattestedCaseIds: stringArray(runtime.unattestedCaseIds),
      frameworkVersion: stringValue(runtime.frameworkVersion) || null,
      buildRevision: stringValue(runtime.buildRevision) || null,
    },
    suite: {
      mode: stringValue(suite.mode) === 'e2e' ? 'e2e' : 'contract',
      label: stringValue(suite.label) || (stringValue(suite.mode) === 'e2e' ? 'DeepSeek 真实生成 E2E' : '确定性产物契约'),
      executionClass: stringValue(suite.executionClass) || undefined,
    },
    dataset: {
      schemaVersion: numberValue(dataset.schemaVersion),
      visibility: dataset.visibility === 'hidden' || dataset.visibility === 'production_replay'
        ? dataset.visibility
        : 'public',
      promptsRedacted: booleanValue(dataset.promptsRedacted),
      sourceIdentitySha256: stringValue(dataset.sourceIdentitySha256) || null,
    },
    retention: {
      databaseEvidenceRetained: booleanValue(retention.databaseEvidenceRetained),
      workspaceRetained: booleanValue(retention.workspaceRetained),
    },
    provenance: {
      gitCommit: stringValue(provenance.gitCommit) || null,
      gitRevision: stringValue(provenance.gitRevision) || null,
      buildRevision: stringValue(provenance.buildRevision) || null,
      frameworkVersion: stringValue(provenance.frameworkVersion) || null,
      casesSha256: stringValue(provenance.casesSha256) || null,
      promptsSha256: stringValue(provenance.promptsSha256) || null,
      datasetRegistrySha256: stringValue(provenance.datasetRegistrySha256) || null,
      snapshotManifestSha256: stringValue(provenance.snapshotManifestSha256) || null,
    },
    dataSnapshots: {
      schemaVersion: numberValue(dataSnapshots.schemaVersion),
      manifestId: stringValue(dataSnapshots.manifestId) || null,
      manifestVersion: stringValue(dataSnapshots.manifestVersion) || null,
      selected: readRecordArray(dataSnapshots.selected).map((item) => ({
        caseId: stringValue(item.caseId),
        id: stringValue(item.id),
        asOf: stringValue(item.asOf),
        payloadSha256: stringValue(item.payloadSha256),
      })).filter((item) => item.caseId && item.id),
    },
    e2eQuality: normalizeE2eQuality(metadata.e2eQuality),
    selection: {
      selectedCases: stringArray(selection.selectedCases),
      limit: typeof selection.limit === 'number' ? selection.limit : null,
      keepProjects: booleanValue(selection.keepProjects),
      caseCount: numberValue(selection.caseCount, results.length),
      concurrency,
      repeat: Math.max(1, numberValue(selection.repeat, 1)),
    },
    skillLockSnapshot: normalizeSkillLockSnapshot(metadata.skillLockSnapshot),
  };
}

export function normalizeCoverage(value: unknown): QuantEvalRun['coverage'] {
  const coverage = isRecord(value) ? value : {};

  function normalizeBucket(raw: unknown) {
    const bucket = isRecord(raw) ? raw : {};
    return Object.fromEntries(
      Object.entries(bucket).map(([key, item]) => {
        const record = isRecord(item) ? item : {};
        return [
          key,
          {
            total: numberValue(record.total),
            passed: numberValue(record.passed),
            failed: numberValue(record.failed),
          },
        ];
      })
    );
  }

  const requiredCoverage = isRecord(coverage.requiredCoverage) ? coverage.requiredCoverage : {};
  const failedTags = isRecord(coverage.failedTags)
    ? Object.fromEntries(Object.entries(coverage.failedTags).map(([key, value]) => [key, stringArray(value)]))
    : {};
  const caseTags = isRecord(coverage.caseTags)
    ? Object.fromEntries(Object.entries(coverage.caseTags).map(([key, value]) => [key, stringArray(value)]))
    : {};
  const rawByLevel = isRecord(coverage.byLevel) ? coverage.byLevel : {};
  const byLevel = Object.fromEntries(
    (['routing', 'contract', 'live_e2e', 'production'] as const).map((level) => [
      level,
      normalizeBucket(rawByLevel[level]),
    ]),
  ) as QuantEvalRun['coverage']['byLevel'];
  const caseLevels = isRecord(coverage.caseLevels)
    ? Object.fromEntries(Object.entries(coverage.caseLevels).map(([key, value]) => [
        key,
        stringArray(value).filter((item) =>
          item === 'routing' || item === 'contract' || item === 'live_e2e' || item === 'production'),
      ])) as QuantEvalRun['coverage']['caseLevels']
    : {};
  const requiredLevels = isRecord(requiredCoverage.levels)
    ? Object.fromEntries(Object.entries(requiredCoverage.levels).map(([key, value]) => [key, stringArray(value)]))
    : {};

  return {
    byCapability: normalizeBucket(coverage.byCapability),
    byType: normalizeBucket(coverage.byType),
    byTag: normalizeBucket(coverage.byTag),
    byLevel,
    caseLevels,
    caseTags,
    failedTags,
    requiredCoverage: {
      capabilities: stringArray(requiredCoverage.capabilities),
      tags: stringArray(requiredCoverage.tags),
      levels: requiredLevels,
    },
  };
}

export function normalizeChecks(value: unknown): QuantEvalCheck[] {
  return readRecordArray(value).map((check) => ({
    id: stringValue(check.id, 'unknown'),
    name: stringValue(check.name, stringValue(check.id, '检查项')),
    status: normalizeStatus(check.status),
    summary: stringValue(check.summary),
  }));
}

export function normalizeStatus(value: unknown): EvalCheckStatus {
  if (value === 'passed' || value === 'failed' || value === 'warning') {
    return value;
  }
  return 'unknown';
}

export function normalizeQueueStatus(value: unknown): QuantEvalQueueStatus {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  return 'failed';
}

export function mapDbEvalRun(record: {
  id: string;
  fileName: string;
  filePath: string;
  reportCreatedAt: Date;
  mtimeMs: number;
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  averageScore: number;
  durationMs: number;
  metadata: unknown;
  coverage: unknown;
  results: unknown;
}): QuantEvalRun {
  const coverage = normalizeCoverage(record.coverage);
  const results = readRecordArray(record.results).map((result) =>
    normalizeResult(result, new Map(), coverage.caseTags));
  const metadataRecord = isRecord(record.metadata) ? record.metadata : {};
  const metadata = normalizeMetadata(
    {
      metadata: metadataRecord,
      schemaVersion: metadataRecord.reportSchemaVersion,
      createdAt: record.reportCreatedAt.toISOString(),
    },
    results,
  );
  return {
    id: record.id,
    fileName: record.fileName,
    filePath: record.filePath,
    createdAt: record.reportCreatedAt.toISOString(),
    mtimeMs: record.mtimeMs,
    passed: record.passed,
    total: record.total,
    passedCount: record.passedCount,
    failedCount: record.failedCount,
    passRate: record.passRate,
    averageScore: record.averageScore,
    durationMs: record.durationMs,
    metadata,
    qualitySummary: buildEvalQualitySummary(results, metadata.selection.repeat),
    e2eQuality: metadata.e2eQuality ?? null,
    coverage,
    results,
  };
}

export function mapDbQueueItem(record: {
  id: string;
  status: string;
  cli: string;
  model: string;
  reasoningEffort: string;
  evaluatorId?: string | null;
  concurrency?: number | null;
  repeat?: number | null;
  mode?: string | null;
  selectedCases: unknown;
  limit: number | null;
  keepProjects: boolean;
  reportId: string | null;
  reportPath: string | null;
  logPath: string | null;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): QuantEvalQueueItem {
  return {
    id: record.id,
    status: normalizeQueueStatus(record.status),
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
    finishedAt: record.finishedAt ? record.finishedAt.toISOString() : null,
    cli: record.cli,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    evaluatorId: stringValue(record.evaluatorId, DEFAULT_EVALUATOR_ID).trim() || DEFAULT_EVALUATOR_ID,
    concurrency: normalizeEvalConcurrency(record.concurrency),
    repeat: Math.min(5, Math.max(1, Math.floor(numberValue(record.repeat, 1)))),
    mode: record.mode === 'e2e' ? 'e2e' : 'contract',
    selectedCases: stringArray(record.selectedCases),
    limit: record.limit,
    keepProjects: record.keepProjects,
    reportId: record.reportId,
    reportPath: record.reportPath,
    logPath: record.logPath,
    pid: record.pid,
    exitCode: record.exitCode,
    error: record.error,
  };
}

export function mapDbRepairTicket(record: {
  id: string;
  runId: string;
  caseId: string;
  title: string;
  status: string;
  severity: string;
  createdAt: Date;
  updatedAt: Date;
  model: string;
  reportPath: string;
  projectId: string | null;
  failures: unknown;
  validationSummaries: unknown;
  suggestedActions: unknown;
  skillVersions: unknown;
}): QuantEvalRepairTicket {
  return {
    id: record.id,
    runId: record.runId,
    caseId: record.caseId,
    title: record.title,
    status: record.status === 'resolved' ? 'resolved' : 'open',
    severity: record.severity === 'high' ? 'high' : 'medium',
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    model: record.model,
    reportPath: record.reportPath,
    projectId: record.projectId,
    failures: stringArray(record.failures),
    validationSummaries: stringArray(record.validationSummaries),
    suggestedActions: stringArray(record.suggestedActions),
    skillVersions: isRecord(record.skillVersions)
      ? Object.fromEntries(Object.entries(record.skillVersions).map(([key, value]) => [key, stringValue(value) || null]))
      : {},
  };
}

export function mapDbSchedule(record: {
  enabled: boolean;
  intervalHours: number;
  cli: string;
  model: string;
  reasoningEffort: string;
  selectedCases: unknown;
  limit: number | null;
  keepProjects: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastQueuedRunId: string | null;
  updatedAt: Date;
}): QuantEvalScheduleConfig {
  return {
    enabled: record.enabled,
    intervalHours: record.intervalHours,
    cli: record.cli,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    selectedCases: stringArray(record.selectedCases),
    limit: record.limit,
    keepProjects: record.keepProjects,
    nextRunAt: record.nextRunAt ? record.nextRunAt.toISOString() : null,
    lastRunAt: record.lastRunAt ? record.lastRunAt.toISOString() : null,
    lastQueuedRunId: record.lastQueuedRunId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function countWarnings(result: JsonRecord): number {
  const validation = isRecord(result.validation) ? result.validation : {};
  const checks = normalizeChecks(validation.checks);
  const eventAudit = isRecord(result.eventAudit) ? result.eventAudit : {};
  return checks.filter((check) => check.status === 'warning').length + numberValue(eventAudit.warningCount);
}

export function computeResultScore(result: JsonRecord): number {
  return resultScore(result);
}

export function normalizeArtifacts(result: JsonRecord): QuantEvalArtifactSummary {
  const artifacts = isRecord(result.artifacts) ? result.artifacts : {};
  const finalData = isRecord(artifacts.finalData) ? artifacts.finalData : {};
  const prefetch = isRecord(result.prefetch) ? result.prefetch : {};
  const quality = isRecord(artifacts.quality) ? artifacts.quality : {};

  return {
    templateId: stringValue(finalData.templateId) || null,
    finalDataPath: stringValue(prefetch.finalDataPath) || null,
    rawFileCount: stringArray(prefetch.rawFiles).length,
    klineRows: numberValue(finalData.klineRows),
    reportRows: numberValue(finalData.reportRows),
    announcementRows: numberValue(finalData.announcementRows),
    tradeRows: numberValue(finalData.tradeRows),
    assetCount: numberValue(finalData.assetCount),
    holdingCount: numberValue(finalData.holdingCount),
    comparisonRows: numberValue(finalData.comparisonRows),
    qualityStatus: stringValue(quality.status) || null,
    hasImageExtraction: booleanValue(finalData.hasImageExtraction),
  };
}

export function normalizeVisualCheck(result: JsonRecord): QuantEvalResult['visualCheck'] {
  const visualCheck = isRecord(result.visualCheck) ? result.visualCheck : null;
  if (!visualCheck) return null;
  return {
    passed: booleanValue(visualCheck.passed),
    screenshotPath: stringValue(visualCheck.screenshotPath) || null,
    screenshots: readRecordArray(visualCheck.screenshots).map((item) => ({
      viewport: stringValue(item.viewport, 'unknown'),
      path: stringValue(item.path),
      width: numberValue(item.width),
      height: numberValue(item.height),
    })).filter((item) => item.path),
    accessibilityIssueCount: numberValue(visualCheck.accessibilityIssueCount),
    failures: stringArray(visualCheck.failures),
  };
}

function normalizeEvaluation(value: unknown): QuantEvalResult['evaluation'] {
  if (!isRecord(value)) return null;
  const dimensions = readRecordArray(value.dimensions)
    .filter((item) => EVAL_SCORE_DIMENSION_IDS.includes(stringValue(item.id) as EvalScoreDimensionId))
    .map((item) => ({
      id: stringValue(item.id) as EvalScoreDimensionId,
      label: stringValue(item.label, stringValue(item.id)),
      score: numberValue(item.score),
      weight: numberValue(item.weight),
      status: normalizeStatus(item.status),
      summary: stringValue(item.summary),
    }));
  const semantic = isRecord(value.semanticReview) ? value.semanticReview : null;
  const reviewer = semantic && isRecord(semantic.reviewer) ? semantic.reviewer : {};
  const usage = semantic && isRecord(semantic.usage) ? semantic.usage : null;
  return {
    evaluatorId: stringValue(value.evaluatorId),
    evaluatorVersion: stringValue(value.evaluatorVersion),
    rubricVersion: stringValue(value.rubricVersion),
    hardGatePassed: booleanValue(value.hardGatePassed),
    passed: booleanValue(value.passed),
    score: numberValue(value.score),
    checks: readRecordArray(value.checks).map((check) => {
      const status = normalizeStatus(check.status);
      return {
        id: stringValue(check.id, 'unknown'),
        name: stringValue(check.name, stringValue(check.id, '评测项')),
        status: status === 'unknown' ? 'failed' as const : status,
        summary: stringValue(check.summary),
      };
    }),
    dimensions,
    semanticReview: semantic
      ? {
          schemaVersion: 1,
          reviewer: {
            provider: stringValue(reviewer.provider),
            model: stringValue(reviewer.model),
            promptVersion: stringValue(reviewer.promptVersion),
            independentFromGenerator: booleanValue(reviewer.independentFromGenerator),
          },
          verdict: semantic.verdict === 'passed' || semantic.verdict === 'warning' ? semantic.verdict : 'failed',
          score: numberValue(semantic.score),
          summary: stringValue(semantic.summary),
          dimensions: readRecordArray(semantic.dimensions).map((item) => ({
            id: stringValue(item.id) as 'intentCoverage' | 'businessCompleteness' | 'grounding' | 'riskCommunication' | 'actionability',
            score: numberValue(item.score),
            rationale: stringValue(item.rationale),
            evidence: stringArray(item.evidence),
          })),
          usage: usage
            ? {
                inputTokens: numberValue(usage.inputTokens),
                outputTokens: numberValue(usage.outputTokens),
                totalTokens: numberValue(usage.totalTokens),
              }
            : null,
        }
      : null,
  };
}

function normalizeStability(value: unknown): QuantEvalResult['stability'] {
  if (!isRecord(value)) return null;
  const attempts = readRecordArray(value.attempts).map((attempt) => ({
    attempt: Math.max(1, numberValue(attempt.attempt, 1)),
    passed: booleanValue(attempt.passed),
    firstPassPassed: booleanValue(attempt.firstPassPassed),
    score: numberValue(attempt.score),
    durationMs: numberValue(attempt.durationMs),
    repairAttempts: numberValue(attempt.repairAttempts),
    projectId: stringValue(attempt.projectId) || null,
    projectPath: stringValue(attempt.projectPath) || null,
    requestId: stringValue(attempt.requestId) || null,
    failures: stringArray(attempt.failures),
    agentAttested: typeof attempt.agentAttested === 'boolean' ? attempt.agentAttested : null,
  }));
  return {
    passed: booleanValue(value.passed, attempts.every((item) => item.passed)),
    repeatCount: Math.max(1, numberValue(value.repeatCount, attempts.length || 1)),
    passedAttempts: numberValue(value.passedAttempts, attempts.filter((item) => item.passed).length),
    passRate: numberValue(value.passRate),
    flaky: booleanValue(value.flaky),
    attempts,
  };
}

export function normalizeEventAudit(result: JsonRecord): QuantEvalResult['eventAudit'] {
  const eventAudit = isRecord(result.eventAudit) ? result.eventAudit : null;
  if (!eventAudit) return null;
  return {
    total: numberValue(eventAudit.total),
    warningCount: numberValue(eventAudit.warningCount),
    errorCount: numberValue(eventAudit.errorCount),
    eventTypes: stringArray(eventAudit.eventTypes),
    stages: stringArray(eventAudit.stages),
  };
}

function normalizeTraceDiagnostics(value: unknown): QuantEvalResult['traceDiagnostics'] {
  if (!isRecord(value)) return null;
  const allowedIds = new Set(['intent', 'planning', 'data', 'artifact', 'visual', 'runtime', 'acceptance']);
  const stages = readRecordArray(value.stages)
    .filter((stage) => allowedIds.has(stringValue(stage.id)))
    .map((stage) => {
      const status = normalizeStatus(stage.status);
      return {
        id: stringValue(stage.id) as NonNullable<QuantEvalResult['traceDiagnostics']>['stages'][number]['id'],
        label: stringValue(stage.label, stringValue(stage.id)),
        status,
        signals: stringArray(stage.signals),
      };
    });
  const primaryFailureStage = stringValue(value.primaryFailureStage);
  return {
    schemaVersion: 1,
    primaryFailureStage: allowedIds.has(primaryFailureStage)
      ? primaryFailureStage as NonNullable<QuantEvalResult['traceDiagnostics']>['primaryFailureStage']
      : null,
    stages,
    observedEventStages: stringArray(value.observedEventStages),
  };
}

function normalizeAgentUsage(value: unknown) {
  const usage = isRecord(value) ? value : {};
  return {
    inputTokens: numberValue(usage.inputTokens),
    outputTokens: numberValue(usage.outputTokens),
    totalTokens: numberValue(usage.totalTokens),
    cachedInputTokens: numberValue(usage.cachedInputTokens),
    cacheMissInputTokens: numberValue(usage.cacheMissInputTokens),
    reasoningTokens: numberValue(usage.reasoningTokens),
  };
}

function normalizeAgentTools(value: unknown) {
  const tools = isRecord(value) ? value : {};
  return {
    total: numberValue(tools.total),
    succeeded: numberValue(tools.succeeded),
    failed: numberValue(tools.failed),
    uncertain: numberValue(tools.uncertain),
    unexpectedFailureCount: numberValue(tools.unexpectedFailureCount),
    workspaceWriteSucceeded: numberValue(tools.workspaceWriteSucceeded),
    submitResultSucceeded: numberValue(tools.submitResultSucceeded),
  };
}

function normalizeAgentRun(value: JsonRecord) {
  return {
    id: stringValue(value.id),
    runInstanceId: stringValue(value.runInstanceId),
    requestId: stringValue(value.requestId) || null,
    status: stringValue(value.status) || null,
    provider: stringValue(value.provider) || null,
    model: stringValue(value.model) || null,
    frameworkVersion: stringValue(value.frameworkVersion) || null,
    buildRevision: stringValue(value.buildRevision) || null,
    startedAt: stringValue(value.startedAt) || null,
    completedAt: stringValue(value.completedAt) || null,
    turns: numberValue(value.turns),
    usage: normalizeAgentUsage(value.usage),
    tools: normalizeAgentTools(value.tools),
  };
}

function normalizeMissionAcceptance(value: unknown): QuantEvalResult['missionAcceptance'] {
  if (!isRecord(value)) return null;
  return {
    missionId: stringValue(value.missionId) || null,
    generationId: stringValue(value.generationId) || null,
    status: stringValue(value.status) || null,
    candidateVersion: numberValue(value.candidateVersion),
    acceptedReceiptId: stringValue(value.acceptedReceiptId) || null,
    acceptedReceiptHash: stringValue(value.acceptedReceiptHash) || null,
    acceptedReceiptType: stringValue(value.acceptedReceiptType) || null,
    acceptedReceiptVerdict: stringValue(value.acceptedReceiptVerdict) || null,
    acceptedSourceRunId: stringValue(value.acceptedSourceRunId) || null,
    acceptedSourceRequestId: stringValue(value.acceptedSourceRequestId) || null,
    acceptedCandidateSource: stringValue(value.acceptedCandidateSource) || null,
  };
}

export function normalizeResult(
  raw: JsonRecord,
  casesById: Map<string, QuantEvalCase>,
  caseTags: Record<string, string[]>
): QuantEvalResult {
  const id = stringValue(raw.id, 'unknown');
  const testCase = casesById.get(id);
  const capabilityId = testCase?.capabilityId ?? stringValue(raw.capabilityId, 'unknown');
  const type = testCase?.type ?? stringValue(raw.type, 'generated_project');
  const validation = isRecord(raw.validation) ? raw.validation : {};
  const checks = normalizeChecks(validation.checks);
  const agentExecution = isRecord(raw.agentExecution) ? raw.agentExecution : null;

  return {
    id,
    name: stringValue(raw.name, testCase?.name ?? id),
    question: stringValue(raw.question, testCase?.question ?? ''),
    projectId: stringValue(raw.projectId) || null,
    projectPath: stringValue(raw.projectPath) || null,
    requestId: stringValue(raw.requestId) || null,
    durationMs: numberValue(raw.durationMs),
    passed: booleanValue(raw.passed),
    firstPassPassed: booleanValue(raw.firstPassPassed, booleanValue(raw.passed) && numberValue(raw.repairAttempts) === 0),
    finalPassed: booleanValue(raw.finalPassed, booleanValue(raw.passed)),
    score: computeResultScore(raw),
    failures: stringArray(raw.failures),
    symbols: stringArray(raw.symbols),
    repairAttempts: numberValue(raw.repairAttempts),
    platformRepairCount: numberValue(raw.platformRepairCount),
    agentExecuted: booleanValue(raw.agentExecuted),
    agentExecution: agentExecution
      ? {
          executed: booleanValue(agentExecution.executed),
          cli: stringValue(agentExecution.cli) || null,
          provider: stringValue(agentExecution.provider) || null,
          model: stringValue(agentExecution.model) || null,
          requestId: stringValue(agentExecution.requestId) || null,
          runIds: stringArray(agentExecution.runIds),
          runs: readRecordArray(agentExecution.runs).map(normalizeAgentRun),
          missionId: stringValue(agentExecution.missionId) || null,
          generationId: stringValue(agentExecution.generationId) || null,
          missionStatus: stringValue(agentExecution.missionStatus) || null,
          candidateVersion: numberValue(agentExecution.candidateVersion),
          acceptedReceiptId: stringValue(agentExecution.acceptedReceiptId) || null,
          acceptedReceiptHash: stringValue(agentExecution.acceptedReceiptHash) || null,
          acceptedReceiptType: stringValue(agentExecution.acceptedReceiptType) || null,
          acceptedReceiptVerdict: stringValue(agentExecution.acceptedReceiptVerdict) || null,
          acceptedSourceRunId: stringValue(agentExecution.acceptedSourceRunId) || null,
          acceptedSourceRequestId: stringValue(agentExecution.acceptedSourceRequestId) || null,
          acceptedCandidateSource: stringValue(agentExecution.acceptedCandidateSource) || null,
          frameworkVersion: stringValue(agentExecution.frameworkVersion) || null,
          buildRevision: stringValue(agentExecution.buildRevision) || null,
          gitRevision: stringValue(agentExecution.gitRevision) || null,
          startedAt: stringValue(agentExecution.startedAt) || null,
          completedAt: stringValue(agentExecution.completedAt) || null,
          turns: numberValue(agentExecution.turns),
          usage: normalizeAgentUsage(agentExecution.usage),
          tools: normalizeAgentTools(agentExecution.tools),
        }
      : null,
    missionAcceptance: normalizeMissionAcceptance(raw.missionAcceptance),
    capabilityId,
    capabilityLabel: EVAL_CAPABILITY_LABELS[capabilityId] ?? capabilityId,
    type,
    typeLabel: EVAL_TYPE_LABELS[type] ?? type,
    tags: caseTags[id] ?? testCase?.tags ?? stringArray(raw.tags),
    validationStatus: normalizeStatus(validation.status),
    validationChecks: checks,
    evaluation: normalizeEvaluation(raw.evaluation),
    stability: normalizeStability(raw.stability),
    eventAudit: normalizeEventAudit(raw),
    traceDiagnostics: normalizeTraceDiagnostics(raw.traceDiagnostics),
    artifacts: normalizeArtifacts(raw),
    visualCheck: normalizeVisualCheck(raw),
  };
}

export function durationSum(results: QuantEvalResult[]): number {
  return results.reduce((total, result) => total + result.durationMs, 0);
}

export function averageScore(results: QuantEvalResult[]): number {
  if (!results.length) return 0;
  return Math.round(results.reduce((total, result) => total + result.score, 0) / results.length);
}

function normalizeE2eQuality(value: unknown): QuantEvalRun['e2eQuality'] {
  if (!isRecord(value)) return null;
  const thresholds = isRecord(value.thresholds) ? value.thresholds : {};
  const summary = isRecord(value.summary) ? value.summary : {};
  const turns = isRecord(summary.turns) ? summary.turns : {};
  const turnMax = isRecord(turns.max) ? turns.max : {};
  const cacheMiss = isRecord(summary.cacheMissInputTokens)
    ? summary.cacheMissInputTokens
    : {};
  const cacheMissMax = isRecord(cacheMiss.max) ? cacheMiss.max : {};
  const tools = isRecord(summary.tools) ? summary.tools : {};
  return {
    passed: booleanValue(value.passed),
    problems: stringArray(value.problems),
    thresholds: {
      maxTurnsPerCase: numberValue(thresholds.maxTurnsPerCase),
      maxCacheMissInputTokensPerCase: numberValue(
        thresholds.maxCacheMissInputTokensPerCase,
      ),
      maxUnexpectedToolFailures: numberValue(thresholds.maxUnexpectedToolFailures),
    },
    summary: {
      caseCount: numberValue(summary.caseCount),
      measuredCaseCount: numberValue(summary.measuredCaseCount),
      missingMetricsCaseIds: stringArray(summary.missingMetricsCaseIds),
      turns: {
        total: numberValue(turns.total),
        average: numberValue(turns.average),
        max: { id: stringValue(turnMax.id) || null, value: numberValue(turnMax.value) },
      },
      cacheMissInputTokens: {
        total: numberValue(cacheMiss.total),
        average: numberValue(cacheMiss.average),
        max: {
          id: stringValue(cacheMissMax.id) || null,
          value: numberValue(cacheMissMax.value),
        },
      },
      tools: {
        unexpectedFailureCount: numberValue(tools.unexpectedFailureCount),
        affectedCaseIds: stringArray(tools.affectedCaseIds),
      },
    },
  };
}

export function normalizeRun(filePath: string, statMtimeMs: number, report: JsonRecord, cases: QuantEvalCase[]): QuantEvalRun {
  const fileName = path.basename(filePath);
  const id = fileName.replace(/\.json$/, '');
  const coverage = normalizeCoverage(report.coverage);
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const results = readRecordArray(report.results).map((result) =>
    normalizeResult(result, casesById, coverage.caseTags)
  );
  const total = numberValue(report.total, results.length);
  const passedCount = numberValue(report.passedCount, results.filter((result) => result.passed).length);
  const failedCount = numberValue(report.failedCount, Math.max(0, total - passedCount));
  const metadata = normalizeMetadata(report, results);

  return {
    id,
    fileName,
    filePath: path.relative(ROOT, filePath),
    createdAt: stringValue(report.createdAt, new Date(statMtimeMs).toISOString()),
    mtimeMs: statMtimeMs,
    passed: booleanValue(report.passed, failedCount === 0),
    total,
    passedCount,
    failedCount,
    passRate: total ? Math.round((passedCount / total) * 100) : 0,
    averageScore: averageScore(results),
    durationMs: durationSum(results),
    metadata,
    qualitySummary: buildEvalQualitySummary(results, metadata.selection.repeat),
    e2eQuality: normalizeE2eQuality(report.e2eQuality) ?? metadata.e2eQuality ?? null,
    coverage,
    results,
  };
}
