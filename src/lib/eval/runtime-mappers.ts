import path from 'node:path';
import {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_EVALUATOR_ID,
  EVAL_CAPABILITY_LABELS,
  EVAL_TYPE_LABELS,
  MAX_EVAL_CONCURRENCY,
} from './constants';
import { ROOT } from './paths';
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
  const lockPath = path.join(ROOT, '.claude', 'skills.lock.json');
  const parsed = await readJson(lockPath).catch(() => null);
  return normalizeSkillLockSnapshot(parsed);
}

export function normalizeMetadata(report: JsonRecord, results: QuantEvalResult[]): QuantEvalRun['metadata'] {
  const metadata = isRecord(report.metadata) ? report.metadata : {};
  const runtime = isRecord(metadata.runtime) ? metadata.runtime : {};
  const selection = isRecord(metadata.selection) ? metadata.selection : {};
  const evaluator = isRecord(metadata.evaluator) ? metadata.evaluator : {};
  const suite = isRecord(metadata.suite) ? metadata.suite : {};
  const provenance = isRecord(metadata.provenance) ? metadata.provenance : {};
  const concurrency = normalizeEvalConcurrency(selection.concurrency ?? evaluator.concurrency);

  return {
    trigger: stringValue(metadata.trigger) || null,
    startedAt: stringValue(metadata.startedAt) || stringValue(report.createdAt) || null,
    finishedAt: stringValue(metadata.finishedAt) || stringValue(report.createdAt) || null,
    command: stringArray(metadata.command),
    evaluator: {
      id: stringValue(evaluator.id) || null,
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
    },
    suite: {
      mode: stringValue(suite.mode) === 'e2e' ? 'e2e' : 'contract',
      label: stringValue(suite.label) || (stringValue(suite.mode) === 'e2e' ? 'DeepSeek 真实生成 E2E' : '确定性产物契约'),
    },
    provenance: {
      gitCommit: stringValue(provenance.gitCommit) || null,
      casesSha256: stringValue(provenance.casesSha256) || null,
      promptsSha256: stringValue(provenance.promptsSha256) || null,
    },
    selection: {
      selectedCases: stringArray(selection.selectedCases),
      limit: typeof selection.limit === 'number' ? selection.limit : null,
      keepProjects: booleanValue(selection.keepProjects),
      caseCount: numberValue(selection.caseCount, results.length),
      concurrency,
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

  return {
    byCapability: normalizeBucket(coverage.byCapability),
    byType: normalizeBucket(coverage.byType),
    byTag: normalizeBucket(coverage.byTag),
    caseTags,
    failedTags,
    requiredCoverage: {
      capabilities: stringArray(requiredCoverage.capabilities),
      tags: stringArray(requiredCoverage.tags),
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
    metadata: record.metadata as QuantEvalRun['metadata'],
    coverage: record.coverage as QuantEvalRun['coverage'],
    results: Array.isArray(record.results) ? record.results as QuantEvalResult[] : [],
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
  const passed = booleanValue(result.passed);
  const failures = stringArray(result.failures);
  if (passed) {
    return Math.max(88, 100 - Math.min(countWarnings(result) * 3, 12));
  }
  return Math.max(0, 60 - failures.length * 12);
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
    failures: stringArray(visualCheck.failures),
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

export function normalizeResult(
  raw: JsonRecord,
  casesById: Map<string, QuantEvalCase>,
  caseTags: Record<string, string[]>
): QuantEvalResult {
  const id = stringValue(raw.id, 'unknown');
  const testCase = casesById.get(id);
  const capabilityId = testCase?.capabilityId ?? 'unknown';
  const type = testCase?.type ?? 'generated_project';
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
    score: computeResultScore(raw),
    failures: stringArray(raw.failures),
    symbols: stringArray(raw.symbols),
    repairAttempts: numberValue(raw.repairAttempts),
    platformRepairCount: numberValue(raw.platformRepairCount),
    agentExecuted: booleanValue(raw.agentExecuted),
    agentExecution: agentExecution
      ? {
          executed: booleanValue(agentExecution.executed),
          provider: stringValue(agentExecution.provider) || null,
          model: stringValue(agentExecution.model) || null,
          requestId: stringValue(agentExecution.requestId) || null,
          startedAt: stringValue(agentExecution.startedAt) || null,
          completedAt: stringValue(agentExecution.completedAt) || null,
        }
      : null,
    capabilityId,
    capabilityLabel: EVAL_CAPABILITY_LABELS[capabilityId] ?? capabilityId,
    type,
    typeLabel: EVAL_TYPE_LABELS[type] ?? type,
    tags: caseTags[id] ?? testCase?.tags ?? [],
    validationStatus: normalizeStatus(validation.status),
    validationChecks: checks,
    eventAudit: normalizeEventAudit(raw),
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
    coverage,
    results,
  };
}
