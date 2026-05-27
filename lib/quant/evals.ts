import fs from 'fs/promises';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

type JsonRecord = Record<string, unknown>;

const ROOT = process.cwd();
const CASES_PATH = path.join(ROOT, 'benchmarks', 'quantpilot', 'cases.json');
const REPORTS_DIR = path.join(ROOT, 'tmp', 'quantpilot-benchmark-reports');
const QUEUE_DIR = path.join(ROOT, 'tmp', 'quantpilot-eval-queue');
const QUEUE_PATH = path.join(QUEUE_DIR, 'queue.json');
const LOG_DIR = path.join(QUEUE_DIR, 'logs');
const REPAIRS_DIR = path.join(ROOT, 'tmp', 'quantpilot-eval-repairs');
const REPAIRS_PATH = path.join(REPAIRS_DIR, 'repairs.json');
const SCHEDULE_PATH = path.join(QUEUE_DIR, 'schedule.json');
let queueKickoffInProgress = false;
const runningChildren = new Map<string, ChildProcess>();

const EVAL_RUNTIME_OPTIONS: QuantEvalRuntimeOption[] = [
  {
    cli: 'claude',
    label: 'Claude Code',
    defaultModel: 'MiniMax-M2.7',
    supportsReasoningEffort: false,
    models: [
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        description: '通过 Anthropic 兼容协议接入 Claude Code 的 MiniMax 模型',
      },
    ],
  },
  {
    cli: 'codex',
    label: 'Codex CLI',
    defaultModel: 'gpt-5.5',
    supportsReasoningEffort: true,
    models: [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        description: '通过 OpenAI 兼容协议接入 Codex CLI 的第三方 GPT 模型',
      },
    ],
  },
];

export const EVAL_CAPABILITY_LABELS: Record<string, string> = {
  fundamental_analysis: '基本面研究',
  technical_analysis: '技术分析',
  backtest_review: '策略回测',
  asset_comparison: '标的对比',
  portfolio_risk: '组合风控',
  stock_diagnosis: '个股诊断',
};

export const EVAL_TYPE_LABELS: Record<string, string> = {
  generated_project: '生成项目',
  clarification_required: '意图澄清',
  clarification_continuation: '澄清承接',
  runtime_registry: '运行时注册',
  repair_plan: '修复计划',
  source_degradation_contract: '信源降级',
};

export type EvalCheckStatus = 'passed' | 'failed' | 'warning' | 'unknown';

export interface QuantEvalCase {
  id: string;
  name: string;
  question: string;
  capabilityId: string;
  capabilityLabel: string;
  type: string;
  typeLabel: string;
  expectedSymbols: string[];
  expectedAssetType: string | null;
  expectedTemplateId: string | null;
  expectedDatasets: string[];
  expectedRawFiles: string[];
  expectedFinalFields: string[];
  tags: string[];
  hasImageAttachment: boolean;
  expectClarification: boolean;
  visualCheck: boolean;
}

export interface QuantEvalCheck {
  id: string;
  name: string;
  status: EvalCheckStatus;
  summary: string;
}

export interface QuantEvalArtifactSummary {
  templateId: string | null;
  finalDataPath: string | null;
  rawFileCount: number;
  klineRows: number;
  reportRows: number;
  announcementRows: number;
  tradeRows: number;
  assetCount: number;
  holdingCount: number;
  comparisonRows: number;
  qualityStatus: string | null;
  hasImageExtraction: boolean;
}

export interface QuantEvalResult {
  id: string;
  name: string;
  question: string;
  projectId: string | null;
  projectPath: string | null;
  durationMs: number;
  passed: boolean;
  score: number;
  failures: string[];
  symbols: string[];
  capabilityId: string;
  capabilityLabel: string;
  type: string;
  typeLabel: string;
  tags: string[];
  validationStatus: EvalCheckStatus;
  validationChecks: QuantEvalCheck[];
  eventAudit: {
    total: number;
    warningCount: number;
    errorCount: number;
    eventTypes: string[];
    stages: string[];
  } | null;
  artifacts: QuantEvalArtifactSummary;
  visualCheck: {
    passed: boolean;
    screenshotPath: string | null;
    failures: string[];
  } | null;
}

export interface QuantEvalRun {
  id: string;
  fileName: string;
  filePath: string;
  createdAt: string;
  mtimeMs: number;
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  averageScore: number;
  durationMs: number;
  metadata: {
    trigger: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    command: string[];
    runtime: {
      cli: string | null;
      model: string | null;
      reasoningEffort: string | null;
    };
    selection: {
      selectedCases: string[];
      limit: number | null;
      keepProjects: boolean;
      caseCount: number;
    };
    skillLockSnapshot: {
      schemaVersion: string | number | null;
      skills: Record<string, {
        version: string | null;
        hash: string | null;
        packageHash: string | null;
        sourcePath: string | null;
        packagePath: string | null;
      }>;
    };
  };
  coverage: {
    byCapability: Record<string, { total: number; passed: number; failed: number }>;
    byType: Record<string, { total: number; passed: number; failed: number }>;
    byTag: Record<string, { total: number; passed: number; failed: number }>;
    caseTags: Record<string, string[]>;
    failedTags: Record<string, string[]>;
    requiredCoverage: {
      capabilities: string[];
      tags: string[];
    };
  };
  results: QuantEvalResult[];
}

export interface QuantEvalDashboardData {
  generatedAt: string;
  reportsDir: string;
  casesPath: string;
  runtimeOptions: QuantEvalRuntimeOption[];
  cases: QuantEvalCase[];
  runs: QuantEvalRun[];
  queue: QuantEvalQueueItem[];
  repairTickets: QuantEvalRepairTicket[];
  schedule: QuantEvalScheduleConfig;
  latestRun: QuantEvalRun | null;
  modelComparison: QuantEvalModelComparison[];
  skillVersionImpact: QuantEvalSkillVersionImpact[];
  summary: {
    caseCount: number;
    reportCount: number;
    capabilityCount: number;
    latestPassRate: number;
    latestAverageScore: number;
    latestPassedCount: number;
    latestFailedCount: number;
    latestTotal: number;
  };
}

export interface QuantEvalRuntimeOption {
  cli: string;
  label: string;
  defaultModel: string;
  supportsReasoningEffort: boolean;
  models: {
    id: string;
    name: string;
    description: string | null;
  }[];
}

export interface QuantEvalQueueItem {
  id: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cli: string;
  model: string;
  reasoningEffort: string;
  selectedCases: string[];
  limit: number | null;
  keepProjects: boolean;
  reportId: string | null;
  reportPath: string | null;
  logPath: string | null;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
}

type QuantEvalQueueStatus = QuantEvalQueueItem['status'];

export interface QuantEvalModelComparison {
  key: string;
  cli: string;
  model: string;
  reasoningEffort: string;
  runs: number;
  latestRunId: string;
  latestPassRate: number;
  averagePassRate: number;
  latestAverageScore: number;
  averageScore: number;
  latestCreatedAt: string;
}

export interface QuantEvalSkillVersionImpact {
  skillId: string;
  version: string;
  runs: number;
  latestRunId: string;
  latestPassRate: number;
  averagePassRate: number;
  latestAverageScore: number;
  averageScore: number;
  latestCreatedAt: string;
}

export interface StartQuantEvalOptions {
  cli?: string;
  model?: string;
  reasoningEffort?: string;
  selectedCases?: string[];
  limit?: number | null;
  keepProjects?: boolean;
}

export interface QuantEvalFlowStep {
  id: string;
  name: string;
  status: 'passed' | 'warning' | 'failed';
  summary: string;
  detail: string | null;
}

export interface QuantEvalFlowSimulation {
  generatedAt: string;
  ready: boolean;
  runtime: {
    cli: string;
    model: string;
    reasoningEffort: string;
  };
  selection: {
    selectedCases: string[];
    limit: number | null;
    keepProjects: boolean;
    caseCount: number;
  };
  selectedCaseIds: string[];
  command: string[];
  steps: QuantEvalFlowStep[];
  warnings: string[];
}

export interface QuantEvalRepairTicket {
  id: string;
  runId: string;
  caseId: string;
  title: string;
  status: 'open' | 'resolved';
  severity: 'high' | 'medium';
  createdAt: string;
  updatedAt: string;
  model: string;
  reportPath: string;
  projectId: string | null;
  failures: string[];
  validationSummaries: string[];
  suggestedActions: string[];
  skillVersions: Record<string, string | null>;
}

export interface QuantEvalScheduleConfig {
  enabled: boolean;
  intervalHours: number;
  cli: string;
  model: string;
  reasoningEffort: string;
  selectedCases: string[];
  limit: number | null;
  keepProjects: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastQueuedRunId: string | null;
  updatedAt: string | null;
}

export interface UpdateQuantEvalScheduleInput {
  enabled?: boolean;
  intervalHours?: number;
  cli?: string;
  model?: string;
  reasoningEffort?: string;
  selectedCases?: string[];
  limit?: number | null;
  keepProjects?: boolean;
  nextRunAt?: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function supportsReasoningEffort(cli: string | null | undefined): boolean {
  return EVAL_RUNTIME_OPTIONS.some((option) => option.cli === cli && option.supportsReasoningEffort);
}

function defaultModelForEvalCli(cli: string | null | undefined): string {
  return EVAL_RUNTIME_OPTIONS.find((option) => option.cli === cli)?.defaultModel ?? EVAL_RUNTIME_OPTIONS[0].defaultModel;
}

function normalizeEvalReasoningEffort(cli: string | null | undefined, value: string | null | undefined): string {
  if (!supportsReasoningEffort(cli)) return '';
  return value || 'low';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function readRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function readJson(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function defaultScheduleConfig(): QuantEvalScheduleConfig {
  return {
    enabled: false,
    intervalHours: 24,
    cli: 'claude',
    model: 'MiniMax-M2.7',
    reasoningEffort: '',
    selectedCases: [],
    limit: null,
    keepProjects: false,
    nextRunAt: null,
    lastRunAt: null,
    lastQueuedRunId: null,
    updatedAt: null,
  };
}

function normalizeSkillLockSnapshot(value: unknown): QuantEvalRun['metadata']['skillLockSnapshot'] {
  const snapshot = isRecord(value) ? value : {};
  const skillsRaw = isRecord(snapshot.skills) ? snapshot.skills : {};
  const skills = Object.fromEntries(
    Object.entries(skillsRaw).map(([skillId, entry]) => {
      const item = isRecord(entry) ? entry : {};
      return [
        skillId,
        {
          version: stringValue(item.version) || null,
          hash: stringValue(item.hash) || null,
          packageHash: stringValue(item.packageHash) || null,
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

async function readCurrentSkillLockSnapshot(): Promise<QuantEvalRun['metadata']['skillLockSnapshot']> {
  const lockPath = path.join(ROOT, '.claude', 'skills.lock.json');
  const parsed = await readJson(lockPath).catch(() => null);
  return normalizeSkillLockSnapshot(parsed);
}

function normalizeMetadata(report: JsonRecord, results: QuantEvalResult[]): QuantEvalRun['metadata'] {
  const metadata = isRecord(report.metadata) ? report.metadata : {};
  const runtime = isRecord(metadata.runtime) ? metadata.runtime : {};
  const selection = isRecord(metadata.selection) ? metadata.selection : {};

  return {
    trigger: stringValue(metadata.trigger) || null,
    startedAt: stringValue(metadata.startedAt) || stringValue(report.createdAt) || null,
    finishedAt: stringValue(metadata.finishedAt) || stringValue(report.createdAt) || null,
    command: stringArray(metadata.command),
    runtime: {
      cli: stringValue(runtime.cli) || 'benchmark',
      model: stringValue(runtime.model) || 'deterministic',
      reasoningEffort: stringValue(runtime.reasoningEffort) || null,
    },
    selection: {
      selectedCases: stringArray(selection.selectedCases),
      limit: typeof selection.limit === 'number' ? selection.limit : null,
      keepProjects: booleanValue(selection.keepProjects),
      caseCount: numberValue(selection.caseCount, results.length),
    },
    skillLockSnapshot: normalizeSkillLockSnapshot(metadata.skillLockSnapshot),
  };
}

function inferCaseType(testCase: JsonRecord): string {
  const explicitType = stringValue(testCase.type);
  if (explicitType) return explicitType;
  if (booleanValue(testCase.expectClarification)) return 'clarification_required';
  return 'generated_project';
}

function buildCaseTags(testCase: JsonRecord): string[] {
  const tags = new Set<string>();
  const capabilityId = stringValue(testCase.capabilityId);
  const type = inferCaseType(testCase);
  const assetType = stringValue(testCase.expectedAssetType);
  const templateId = stringValue(testCase.expectedTemplateId);

  if (capabilityId) tags.add(capabilityId);
  if (type) tags.add(type);
  if (assetType) tags.add(`asset:${assetType}`);
  if (templateId) tags.add(`template:${templateId}`);
  if (booleanValue(testCase.expectClarification)) tags.add('intent:clarification_required');
  if (testCase.imageAttachment) tags.add('input:image_attachment');
  if (booleanValue(testCase.visualCheck)) tags.add('visual:playwright');
  if (booleanValue(testCase.expectedImageExtraction)) tags.add('evidence:image_extraction');
  if (type === 'clarification_continuation') tags.add('intent:clarification_continuation');
  if (type === 'repair_plan') tags.add('validation:repair_plan');
  if (type === 'source_degradation_contract') tags.add('data:source_degradation');
  if (type === 'runtime_registry') tags.add('runtime:codex_gpt55');
  if (stringArray(testCase.expectedSymbols).length > 1) tags.add('data:multi_symbol');

  return Array.from(tags);
}

function normalizeCase(testCase: JsonRecord): QuantEvalCase {
  const capabilityId = stringValue(testCase.capabilityId, 'unknown');
  const type = inferCaseType(testCase);
  const expectedSymbols = [
    ...new Set([
      ...stringArray(testCase.expectedSymbols),
      stringValue(testCase.expectedSymbol),
    ].filter(Boolean)),
  ];

  return {
    id: stringValue(testCase.id, 'unknown'),
    name: stringValue(testCase.name, stringValue(testCase.id, '未命名用例')),
    question: stringValue(testCase.question),
    capabilityId,
    capabilityLabel: EVAL_CAPABILITY_LABELS[capabilityId] ?? capabilityId,
    type,
    typeLabel: EVAL_TYPE_LABELS[type] ?? type,
    expectedSymbols,
    expectedAssetType: stringValue(testCase.expectedAssetType) || null,
    expectedTemplateId: stringValue(testCase.expectedTemplateId) || null,
    expectedDatasets: stringArray(testCase.expectedDatasets),
    expectedRawFiles: stringArray(testCase.expectedRawFiles),
    expectedFinalFields: stringArray(testCase.expectedFinalFields),
    tags: buildCaseTags(testCase),
    hasImageAttachment: Boolean(testCase.imageAttachment),
    expectClarification: booleanValue(testCase.expectClarification),
    visualCheck: booleanValue(testCase.visualCheck),
  };
}

function normalizeCoverage(value: unknown): QuantEvalRun['coverage'] {
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

function normalizeChecks(value: unknown): QuantEvalCheck[] {
  return readRecordArray(value).map((check) => ({
    id: stringValue(check.id, 'unknown'),
    name: stringValue(check.name, stringValue(check.id, '检查项')),
    status: normalizeStatus(check.status),
    summary: stringValue(check.summary),
  }));
}

function normalizeStatus(value: unknown): EvalCheckStatus {
  if (value === 'passed' || value === 'failed' || value === 'warning') {
    return value;
  }
  return 'unknown';
}

function normalizeQueueStatus(value: unknown): QuantEvalQueueStatus {
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

function countWarnings(result: JsonRecord): number {
  const validation = isRecord(result.validation) ? result.validation : {};
  const checks = normalizeChecks(validation.checks);
  const eventAudit = isRecord(result.eventAudit) ? result.eventAudit : {};
  return checks.filter((check) => check.status === 'warning').length + numberValue(eventAudit.warningCount);
}

function computeResultScore(result: JsonRecord): number {
  const passed = booleanValue(result.passed);
  const failures = stringArray(result.failures);
  if (passed) {
    return Math.max(88, 100 - Math.min(countWarnings(result) * 3, 12));
  }
  return Math.max(0, 60 - failures.length * 12);
}

function normalizeArtifacts(result: JsonRecord): QuantEvalArtifactSummary {
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

function normalizeVisualCheck(result: JsonRecord): QuantEvalResult['visualCheck'] {
  const visualCheck = isRecord(result.visualCheck) ? result.visualCheck : null;
  if (!visualCheck) return null;
  return {
    passed: booleanValue(visualCheck.passed),
    screenshotPath: stringValue(visualCheck.screenshotPath) || null,
    failures: stringArray(visualCheck.failures),
  };
}

function normalizeEventAudit(result: JsonRecord): QuantEvalResult['eventAudit'] {
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

function normalizeResult(
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

  return {
    id,
    name: stringValue(raw.name, testCase?.name ?? id),
    question: stringValue(raw.question, testCase?.question ?? ''),
    projectId: stringValue(raw.projectId) || null,
    projectPath: stringValue(raw.projectPath) || null,
    durationMs: numberValue(raw.durationMs),
    passed: booleanValue(raw.passed),
    score: computeResultScore(raw),
    failures: stringArray(raw.failures),
    symbols: stringArray(raw.symbols),
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

function durationSum(results: QuantEvalResult[]): number {
  return results.reduce((total, result) => total + result.durationMs, 0);
}

function averageScore(results: QuantEvalResult[]): number {
  if (!results.length) return 0;
  return Math.round(results.reduce((total, result) => total + result.score, 0) / results.length);
}

function normalizeRun(filePath: string, statMtimeMs: number, report: JsonRecord, cases: QuantEvalCase[]): QuantEvalRun {
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

async function readQueue(): Promise<QuantEvalQueueItem[]> {
  const parsed = await readJson(QUEUE_PATH).catch(() => []);
  const items = Array.isArray(parsed) ? parsed : [];
  return items
    .filter(isRecord)
    .map((item): QuantEvalQueueItem => ({
      id: stringValue(item.id),
      status: normalizeQueueStatus(item.status),
      createdAt: stringValue(item.createdAt, new Date().toISOString()),
      startedAt: stringValue(item.startedAt) || null,
      finishedAt: stringValue(item.finishedAt) || null,
      cli: stringValue(item.cli, 'claude'),
      model: stringValue(item.model, defaultModelForEvalCli(stringValue(item.cli, 'claude'))),
      reasoningEffort: normalizeEvalReasoningEffort(stringValue(item.cli, 'claude'), stringValue(item.reasoningEffort)),
      selectedCases: stringArray(item.selectedCases),
      limit: typeof item.limit === 'number' ? item.limit : null,
      keepProjects: booleanValue(item.keepProjects),
      reportId: stringValue(item.reportId) || null,
      reportPath: stringValue(item.reportPath) || null,
      logPath: stringValue(item.logPath) || null,
      pid: typeof item.pid === 'number' ? item.pid : null,
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
      error: stringValue(item.error) || null,
    }))
    .filter((item) => item.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);
}

async function writeQueue(items: QuantEvalQueueItem[]): Promise<void> {
  await writeJson(QUEUE_PATH, items.slice(0, 80));
}

function buildVirtualQueueItem(options: StartQuantEvalOptions = {}): QuantEvalQueueItem {
  const cli = options.cli || 'claude';
  const selectedCases = Array.isArray(options.selectedCases)
    ? options.selectedCases.map(String).filter(Boolean)
    : [];
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;

  return {
    id: 'eval-run-simulation',
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    cli,
    model: options.model || defaultModelForEvalCli(cli),
    reasoningEffort: normalizeEvalReasoningEffort(cli, options.reasoningEffort),
    selectedCases,
    limit,
    keepProjects: Boolean(options.keepProjects),
    reportId: null,
    reportPath: null,
    logPath: null,
    pid: null,
    exitCode: null,
    error: null,
  };
}

async function updateQueueItem(id: string, patch: Partial<QuantEvalQueueItem>): Promise<QuantEvalQueueItem | null> {
  const queue = await readQueue();
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  queue[index] = { ...queue[index], ...patch };
  await writeQueue(queue);
  return queue[index];
}

async function latestReportAfter(startedAtMs: number): Promise<QuantEvalRun | null> {
  const runs = await getQuantEvalRuns(5);
  return runs.find((run) => run.mtimeMs >= startedAtMs - 1000) ?? null;
}

async function readRepairTickets(): Promise<QuantEvalRepairTicket[]> {
  const parsed = await readJson(REPAIRS_PATH).catch(() => []);
  const items = Array.isArray(parsed) ? parsed : [];
  return items
    .filter(isRecord)
    .map((item): QuantEvalRepairTicket => ({
      id: stringValue(item.id),
      runId: stringValue(item.runId),
      caseId: stringValue(item.caseId),
      title: stringValue(item.title, '未命名修复单'),
      status: item.status === 'resolved' ? 'resolved' : 'open',
      severity: item.severity === 'high' ? 'high' : 'medium',
      createdAt: stringValue(item.createdAt, new Date().toISOString()),
      updatedAt: stringValue(item.updatedAt, new Date().toISOString()),
      model: stringValue(item.model),
      reportPath: stringValue(item.reportPath),
      projectId: stringValue(item.projectId) || null,
      failures: stringArray(item.failures),
      validationSummaries: stringArray(item.validationSummaries),
      suggestedActions: stringArray(item.suggestedActions),
      skillVersions: isRecord(item.skillVersions)
        ? Object.fromEntries(Object.entries(item.skillVersions).map(([key, value]) => [key, stringValue(value) || null]))
        : {},
    }))
    .filter((item) => item.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

async function writeRepairTickets(items: QuantEvalRepairTicket[]): Promise<void> {
  await writeJson(REPAIRS_PATH, items.slice(0, 200));
}

function suggestedActionsForResult(result: QuantEvalResult): string[] {
  const actions = new Set<string>();
  result.validationChecks.forEach((check) => {
    if (check.status !== 'failed') return;
    if (check.id.includes('build')) actions.add('检查生成项目依赖和 Next.js build 输出，优先修复编译错误。');
    if (check.id.includes('chart')) actions.add('检查可视化模板是否生成 K 线、成交量或场景化图表容器。');
    if (check.id.includes('market')) actions.add('确认 /api/market 同源代理和后端 8000 数据服务可用。');
    if (check.id.includes('artifact')) actions.add('清理外部 CDN、mock 数据、明文密钥和非标准数据绑定。');
    if (check.id.includes('data')) actions.add('检查 data_file/final/dashboard-data.json、evidence/sources.json 和 data_quality.json。');
  });
  if (result.eventAudit?.errorCount) {
    actions.add('检查 .quantpilot/events.jsonl 中 error 事件，补齐阶段化执行事件。');
  }
  if (!actions.size) {
    actions.add('查看失败用例的 failures 和 validation checks，定位生成链路的第一个失败点。');
  }
  return Array.from(actions);
}

async function createRepairTicketsForRun(run: QuantEvalRun): Promise<QuantEvalRepairTicket[]> {
  if (run.passed) return readRepairTickets();
  const existing = await readRepairTickets();
  const existingKeys = new Set(existing.map((ticket) => `${ticket.runId}:${ticket.caseId}`));
  const skillVersions = Object.fromEntries(
    Object.entries(run.metadata.skillLockSnapshot.skills).map(([skillId, entry]) => [skillId, entry.version])
  );
  const createdAt = new Date().toISOString();
  const newTickets = run.results
    .filter((result) => !result.passed)
    .filter((result) => !existingKeys.has(`${run.id}:${result.id}`))
    .map((result): QuantEvalRepairTicket => ({
      id: uniqueId('repair'),
      runId: run.id,
      caseId: result.id,
      title: `${result.name} 回归失败`,
      status: 'open',
      severity: result.validationChecks.some((check) => check.status === 'failed') ? 'high' : 'medium',
      createdAt,
      updatedAt: createdAt,
      model: `${run.metadata.runtime.cli ?? '-'} / ${run.metadata.runtime.model ?? '-'}`,
      reportPath: run.filePath,
      projectId: result.projectId,
      failures: result.failures,
      validationSummaries: result.validationChecks
        .filter((check) => check.status !== 'passed')
        .map((check) => `${check.name || check.id}: ${check.summary}`),
      suggestedActions: suggestedActionsForResult(result),
      skillVersions,
    }));
  if (!newTickets.length) return existing;
  const merged = [...newTickets, ...existing];
  await writeRepairTickets(merged);
  return merged;
}

async function readScheduleConfig(): Promise<QuantEvalScheduleConfig> {
  const parsed = await readJson(SCHEDULE_PATH).catch(() => null);
  const record = isRecord(parsed) ? parsed : {};
  return {
    ...defaultScheduleConfig(),
    enabled: booleanValue(record.enabled),
    intervalHours:
      typeof record.intervalHours === 'number' && Number.isFinite(record.intervalHours) && record.intervalHours > 0
        ? Math.min(168, Math.max(1, Math.floor(record.intervalHours)))
        : 24,
    cli: stringValue(record.cli, 'claude'),
    model: stringValue(record.model, 'MiniMax-M2.7'),
    reasoningEffort: normalizeEvalReasoningEffort(stringValue(record.cli, 'claude'), stringValue(record.reasoningEffort)),
    selectedCases: stringArray(record.selectedCases),
    limit: typeof record.limit === 'number' ? record.limit : null,
    keepProjects: booleanValue(record.keepProjects),
    nextRunAt: stringValue(record.nextRunAt) || null,
    lastRunAt: stringValue(record.lastRunAt) || null,
    lastQueuedRunId: stringValue(record.lastQueuedRunId) || null,
    updatedAt: stringValue(record.updatedAt) || null,
  };
}

async function writeScheduleConfig(config: QuantEvalScheduleConfig): Promise<QuantEvalScheduleConfig> {
  await writeJson(SCHEDULE_PATH, config);
  return config;
}

function buildBenchmarkArgs(item: QuantEvalQueueItem): string[] {
  const args = [
    'scripts/run-quant-benchmarks.js',
    '--trigger=eval-backend',
    `--cli=${item.cli}`,
    `--model=${item.model}`,
  ];
  if (supportsReasoningEffort(item.cli)) {
    args.push(`--reasoning-effort=${item.reasoningEffort || 'low'}`);
  }

  item.selectedCases.forEach((caseId) => {
    args.push('--case', caseId);
  });
  if (item.limit) {
    args.push('--limit', String(item.limit));
  }
  if (item.keepProjects) {
    args.push('--keep-projects');
  }
  return args;
}

function runBenchmarkQueueItem(item: QuantEvalQueueItem) {
  const startedAtMs = Date.now();
  const logPath = path.join(LOG_DIR, `${item.id}.log`);
  void (async () => {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await updateQueueItem(item.id, {
      status: 'running',
      startedAt: new Date(startedAtMs).toISOString(),
      logPath: path.relative(ROOT, logPath),
      error: null,
    });

    const args = buildBenchmarkArgs(item);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        QUANTPILOT_EVAL_TRIGGER: 'eval-backend',
        QUANTPILOT_EVAL_CLI: item.cli,
        QUANTPILOT_EVAL_MODEL: item.model,
        ...(supportsReasoningEffort(item.cli) ? { QUANTPILOT_EVAL_REASONING_EFFORT: item.reasoningEffort || 'low' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningChildren.set(item.id, child);
    await updateQueueItem(item.id, { pid: child.pid ?? null });

    const appendLog = async (chunk: Buffer | string) => {
      await fs.appendFile(logPath, chunk);
    };

    child.stdout.on('data', (chunk) => {
      void appendLog(chunk);
    });
    child.stderr.on('data', (chunk) => {
      void appendLog(chunk);
    });
    child.on('error', (error) => {
      void (async () => {
        const current = (await readQueue()).find((entry) => entry.id === item.id);
        if (current?.status === 'cancelled') {
          runningChildren.delete(item.id);
          await processEvalQueue();
          return;
        }
        await updateQueueItem(item.id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          exitCode: null,
          error: error.message,
        });
        runningChildren.delete(item.id);
        await processEvalQueue();
      })();
    });
    child.on('close', (code, signal) => {
      void (async () => {
        const current = (await readQueue()).find((entry) => entry.id === item.id);
        if (current?.status === 'cancelled') {
          runningChildren.delete(item.id);
          await processEvalQueue();
          return;
        }
        const report = await latestReportAfter(startedAtMs);
        await updateQueueItem(item.id, {
          status: code === 0 ? 'passed' : 'failed',
          finishedAt: new Date().toISOString(),
          exitCode: code,
          reportId: report?.id ?? null,
          reportPath: report?.filePath ?? null,
          error: code === 0 ? null : `benchmark 退出码 ${code ?? signal ?? 'unknown'}`,
        });
        runningChildren.delete(item.id);
        if (report && !report.passed) {
          await createRepairTicketsForRun(report);
        }
        await processEvalQueue();
      })();
    });
  })();
}

async function processEvalQueue(): Promise<void> {
  if (queueKickoffInProgress) return;
  queueKickoffInProgress = true;
  try {
    const queue = await readQueue();
    if (queue.some((item) => item.status === 'running')) {
      return;
    }
    const next = queue
      .filter((item) => item.status === 'queued')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    if (!next) return;
    runBenchmarkQueueItem(next);
  } finally {
    queueKickoffInProgress = false;
  }
}

function buildModelComparison(runs: QuantEvalRun[]): QuantEvalModelComparison[] {
  const groups = new Map<string, QuantEvalRun[]>();
  runs.forEach((run) => {
    const cli = run.metadata.runtime.cli ?? 'unknown';
    const model = run.metadata.runtime.model ?? 'unknown';
    const reasoningEffort = run.metadata.runtime.reasoningEffort ?? '-';
    const key = `${cli}:${model}:${reasoningEffort}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  });

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const sorted = [...group].sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latest = sorted[0];
      return {
        key,
        cli: latest.metadata.runtime.cli ?? 'unknown',
        model: latest.metadata.runtime.model ?? 'unknown',
        reasoningEffort: latest.metadata.runtime.reasoningEffort ?? '-',
        runs: sorted.length,
        latestRunId: latest.id,
        latestPassRate: latest.passRate,
        averagePassRate: Math.round(sorted.reduce((total, run) => total + run.passRate, 0) / sorted.length),
        latestAverageScore: latest.averageScore,
        averageScore: Math.round(sorted.reduce((total, run) => total + run.averageScore, 0) / sorted.length),
        latestCreatedAt: latest.createdAt,
      };
    })
    .sort((a, b) => b.latestCreatedAt.localeCompare(a.latestCreatedAt));
}

function buildSkillVersionImpact(runs: QuantEvalRun[]): QuantEvalSkillVersionImpact[] {
  const groups = new Map<string, { skillId: string; version: string; runs: QuantEvalRun[] }>();

  runs.forEach((run) => {
    Object.entries(run.metadata.skillLockSnapshot.skills).forEach(([skillId, entry]) => {
      const version = entry.version ?? 'unknown';
      const key = `${skillId}@${version}`;
      const group = groups.get(key) ?? { skillId, version, runs: [] };
      group.runs.push(run);
      groups.set(key, group);
    });
  });

  return Array.from(groups.values())
    .map((group) => {
      const sorted = [...group.runs].sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latest = sorted[0];
      return {
        skillId: group.skillId,
        version: group.version,
        runs: sorted.length,
        latestRunId: latest.id,
        latestPassRate: latest.passRate,
        averagePassRate: Math.round(sorted.reduce((total, run) => total + run.passRate, 0) / sorted.length),
        latestAverageScore: latest.averageScore,
        averageScore: Math.round(sorted.reduce((total, run) => total + run.averageScore, 0) / sorted.length),
        latestCreatedAt: latest.createdAt,
      };
    })
    .sort((a, b) => b.latestCreatedAt.localeCompare(a.latestCreatedAt))
    .slice(0, 30);
}

export async function getQuantEvalCases(): Promise<QuantEvalCase[]> {
  const parsed = await readJson(CASES_PATH).catch(() => []);
  return readRecordArray(parsed).map(normalizeCase);
}

export async function getQuantEvalRuns(limit = 30): Promise<QuantEvalRun[]> {
  const cases = await getQuantEvalCases();
  const files = await fs
    .readdir(REPORTS_DIR)
    .then((items) => items.filter((item) => /^report-\d+\.json$/.test(item)))
    .catch(() => []);

  const runs = await Promise.all(
    files.map(async (fileName) => {
      const filePath = path.join(REPORTS_DIR, fileName);
      const stat = await fs.stat(filePath);
      const parsed = await readJson(filePath);
      return normalizeRun(filePath, stat.mtimeMs, isRecord(parsed) ? parsed : {}, cases);
    })
  );

  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

export async function getQuantEvalQueue(): Promise<QuantEvalQueueItem[]> {
  return readQueue();
}

export async function cancelQuantEvalRun(queueId: string): Promise<QuantEvalQueueItem> {
  const queue = await readQueue();
  const item = queue.find((entry) => entry.id === queueId);
  if (!item) {
    throw new Error('未找到评测队列任务。');
  }
  if (item.status !== 'queued' && item.status !== 'running') {
    return item;
  }

  if (item.status === 'running') {
    const child = runningChildren.get(item.id);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    } else if (item.pid) {
      try {
        process.kill(item.pid, 'SIGTERM');
      } catch {
        // 进程可能已经自然退出，队列状态仍然按取消处理。
      }
    }
    runningChildren.delete(item.id);
  }

  const updated = await updateQueueItem(item.id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
    error: '用户取消评测任务。',
    exitCode: null,
  });
  await processEvalQueue();
  if (!updated) {
    throw new Error('取消评测任务失败。');
  }
  return updated;
}

export async function simulateQuantEvalFlow(options: StartQuantEvalOptions = {}): Promise<QuantEvalFlowSimulation> {
  const generatedAt = new Date().toISOString();
  const steps: QuantEvalFlowStep[] = [];
  const warnings: string[] = [];
  const allCases = await getQuantEvalCases();
  const selectedCases = Array.isArray(options.selectedCases)
    ? options.selectedCases.map(String).filter(Boolean)
    : [];
  const selectedSet = selectedCases.length
    ? allCases.filter((testCase) => selectedCases.includes(testCase.id))
    : allCases;
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;
  const scopedCases = limit ? selectedSet.slice(0, limit) : selectedSet;
  const missingCases = selectedCases.filter((caseId) => !allCases.some((testCase) => testCase.id === caseId));
  const virtualItem = buildVirtualQueueItem({ ...options, selectedCases, limit });
  const command = [process.execPath, ...buildBenchmarkArgs(virtualItem)];

  const pushStep = (step: QuantEvalFlowStep) => {
    steps.push(step);
    if (step.status === 'warning') {
      warnings.push(step.summary);
    }
  };

  pushStep({
    id: 'case-selection',
    name: '用例选择',
    status: scopedCases.length && !missingCases.length ? 'passed' : 'failed',
    summary: scopedCases.length
      ? `已选择 ${scopedCases.length} 个用例。`
      : '没有匹配的评测用例。',
    detail: missingCases.length ? `未找到用例：${missingCases.join(', ')}` : null,
  });

  const runtime = EVAL_RUNTIME_OPTIONS.find((option) => option.cli === virtualItem.cli);
  const modelKnown = runtime?.models.some((model) => model.id === virtualItem.model);
  pushStep({
    id: 'runtime',
    name: '评测器运行时',
    status: runtime && modelKnown ? 'passed' : runtime ? 'warning' : 'failed',
    summary: runtime
      ? `${runtime.label} / ${virtualItem.model}`
      : `未注册运行器：${virtualItem.cli}`,
    detail: runtime && !modelKnown ? '模型不在运行器白名单内，将按传入模型尝试执行。' : null,
  });

  const benchmarkScript = path.join(ROOT, 'scripts', 'run-quant-benchmarks.js');
  const scriptStat = await fs.stat(benchmarkScript).catch(() => null);
  pushStep({
    id: 'benchmark-script',
    name: 'Benchmark 脚本',
    status: scriptStat ? 'passed' : 'failed',
    summary: scriptStat ? 'benchmark 入口脚本存在。' : 'benchmark 入口脚本缺失。',
    detail: path.relative(ROOT, benchmarkScript),
  });

  const queueReady = await fs.mkdir(QUEUE_DIR, { recursive: true }).then(() => true).catch(() => false);
  const logReady = await fs.mkdir(LOG_DIR, { recursive: true }).then(() => true).catch(() => false);
  const reportReady = await fs.mkdir(REPORTS_DIR, { recursive: true }).then(() => true).catch(() => false);
  const repairReady = await fs.mkdir(REPAIRS_DIR, { recursive: true }).then(() => true).catch(() => false);
  pushStep({
    id: 'storage',
    name: '本地存储',
    status: queueReady && logReady && reportReady && repairReady ? 'passed' : 'failed',
    summary: queueReady && logReady && reportReady && repairReady
      ? '队列、日志、报告和修复单目录可写。'
      : '部分评测目录不可写。',
    detail: [QUEUE_DIR, LOG_DIR, REPORTS_DIR, REPAIRS_DIR].map((item) => path.relative(ROOT, item)).join(' · '),
  });

  const runs = await getQuantEvalRuns(3);
  pushStep({
    id: 'report-parser',
    name: '报告解析',
    status: runs.length ? 'passed' : 'warning',
    summary: runs.length ? `已解析 ${runs.length} 份最近报告。` : '暂无历史报告，首次运行后才会生成运行记录。',
    detail: runs[0]?.filePath ?? null,
  });

  const tickets = await readRepairTickets();
  pushStep({
    id: 'repair-sink',
    name: '修复单沉淀',
    status: 'passed',
    summary: `修复单存储可读，当前 ${tickets.length} 条。`,
    detail: path.relative(ROOT, REPAIRS_PATH),
  });

  pushStep({
    id: 'command',
    name: '执行命令',
    status: command.length > 2 ? 'passed' : 'failed',
    summary: '已生成 benchmark 执行命令。',
    detail: command.join(' '),
  });

  return {
    generatedAt,
    ready: steps.every((step) => step.status !== 'failed'),
    runtime: {
      cli: virtualItem.cli,
      model: virtualItem.model,
      reasoningEffort: virtualItem.reasoningEffort,
    },
    selection: {
      selectedCases,
      limit,
      keepProjects: virtualItem.keepProjects,
      caseCount: scopedCases.length,
    },
    selectedCaseIds: scopedCases.map((testCase) => testCase.id),
    command,
    steps,
    warnings,
  };
}

export async function startQuantEvalRun(options: StartQuantEvalOptions = {}): Promise<QuantEvalQueueItem> {
  const queue = await readQueue();
  const item: QuantEvalQueueItem = {
    ...buildVirtualQueueItem(options),
    id: uniqueId('eval-run'),
    createdAt: new Date().toISOString(),
  };

  await writeQueue([item, ...queue]);
  await processEvalQueue();
  return item;
}

export async function updateQuantEvalSchedule(input: UpdateQuantEvalScheduleInput): Promise<QuantEvalScheduleConfig> {
  const current = await readScheduleConfig();
  const intervalHours =
    typeof input.intervalHours === 'number' && Number.isFinite(input.intervalHours) && input.intervalHours > 0
      ? Math.min(168, Math.max(1, Math.floor(input.intervalHours)))
      : current.intervalHours;
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : current.enabled;
  const now = new Date();
  const nextRunAt =
    input.nextRunAt !== undefined
      ? input.nextRunAt
      : enabled
        ? current.nextRunAt ?? addHours(now, intervalHours).toISOString()
        : null;
  return writeScheduleConfig({
    ...current,
    enabled,
    intervalHours,
    cli: input.cli || current.cli,
    model: input.model || (input.cli && input.cli !== current.cli ? defaultModelForEvalCli(input.cli) : current.model),
    reasoningEffort: normalizeEvalReasoningEffort(input.cli || current.cli, input.reasoningEffort || current.reasoningEffort),
    selectedCases: Array.isArray(input.selectedCases) ? input.selectedCases.map(String).filter(Boolean) : current.selectedCases,
    limit:
      input.limit === null
        ? null
        : typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
          ? Math.floor(input.limit)
          : current.limit,
    keepProjects: typeof input.keepProjects === 'boolean' ? input.keepProjects : current.keepProjects,
    nextRunAt,
    updatedAt: now.toISOString(),
  });
}

export async function checkQuantEvalSchedule(): Promise<{ queued: boolean; schedule: QuantEvalScheduleConfig; item: QuantEvalQueueItem | null }> {
  const schedule = await readScheduleConfig();
  if (!schedule.enabled || !schedule.nextRunAt) {
    return { queued: false, schedule, item: null };
  }
  const now = new Date();
  if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
    return { queued: false, schedule, item: null };
  }
  const item = await startQuantEvalRun({
    cli: schedule.cli,
    model: schedule.model,
    reasoningEffort: schedule.reasoningEffort,
    selectedCases: schedule.selectedCases,
    limit: schedule.limit,
    keepProjects: schedule.keepProjects,
  });
  const updated = await writeScheduleConfig({
    ...schedule,
    lastRunAt: now.toISOString(),
    lastQueuedRunId: item.id,
    nextRunAt: addHours(now, schedule.intervalHours).toISOString(),
    updatedAt: now.toISOString(),
  });
  return { queued: true, schedule: updated, item };
}

export async function getQuantEvalRun(runId: string): Promise<QuantEvalRun | null> {
  if (!/^report-\d+$/.test(runId)) {
    return null;
  }
  const cases = await getQuantEvalCases();
  const filePath = path.join(REPORTS_DIR, `${runId}.json`);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  const parsed = await readJson(filePath).catch(() => null);
  if (!isRecord(parsed)) return null;
  return normalizeRun(filePath, stat.mtimeMs, parsed, cases);
}

export async function getQuantEvalDashboardData(): Promise<QuantEvalDashboardData> {
  const [cases, runs, queue, repairTickets, schedule] = await Promise.all([
    getQuantEvalCases(),
    getQuantEvalRuns(),
    getQuantEvalQueue(),
    readRepairTickets(),
    readScheduleConfig(),
  ]);
  const latestRun = runs[0] ?? null;
  const capabilities = new Set(cases.map((testCase) => testCase.capabilityId));

  return {
    generatedAt: new Date().toISOString(),
    reportsDir: path.relative(ROOT, REPORTS_DIR),
    casesPath: path.relative(ROOT, CASES_PATH),
    runtimeOptions: EVAL_RUNTIME_OPTIONS,
    cases,
    runs,
    queue,
    repairTickets,
    schedule,
    latestRun,
    modelComparison: buildModelComparison(runs),
    skillVersionImpact: buildSkillVersionImpact(runs),
    summary: {
      caseCount: cases.length,
      reportCount: runs.length,
      capabilityCount: capabilities.size,
      latestPassRate: latestRun?.passRate ?? 0,
      latestAverageScore: latestRun?.averageScore ?? 0,
      latestPassedCount: latestRun?.passedCount ?? 0,
      latestFailedCount: latestRun?.failedCount ?? 0,
      latestTotal: latestRun?.total ?? 0,
    },
  };
}
