export type EvalCheckStatus = 'passed' | 'failed' | 'warning' | 'unknown';
export type QuantEvalExecutionMode = 'contract' | 'e2e';

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

export interface QuantEvalSetDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  caseIds: string[];
  custom: boolean;
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
  requestId: string | null;
  durationMs: number;
  passed: boolean;
  score: number;
  failures: string[];
  symbols: string[];
  repairAttempts: number;
  platformRepairCount: number;
  agentExecuted: boolean;
  agentExecution: {
    executed: boolean;
    provider: string | null;
    model: string | null;
    requestId: string | null;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
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
    evaluator: {
      id: string | null;
      concurrency: number;
    };
    runtime: {
      cli: string | null;
      model: string | null;
      reasoningEffort: string | null;
      configuredModel?: string | null;
      agentExecuted?: boolean;
      executedCaseCount?: number;
      unattestedCaseIds?: string[];
    };
    suite?: {
      mode: QuantEvalExecutionMode;
      label: string;
    };
    provenance?: {
      gitCommit: string | null;
      casesSha256: string | null;
      promptsSha256: string | null;
    };
    selection: {
      selectedCases: string[];
      limit: number | null;
      keepProjects: boolean;
      caseCount: number;
      concurrency: number;
    };
    skillLockSnapshot: {
      schemaVersion: string | number | null;
      skills: Record<
        string,
        {
          version: string | null;
          hash: string | null;
          packageHash: string | null;
          sourceSha256?: string | null;
          packageSha256?: string | null;
          sourcePath: string | null;
          packagePath: string | null;
        }
      >;
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
  customEvalSets: QuantEvalSetDefinition[];
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

export interface CreateQuantEvalCaseInput {
  id?: string;
  name?: string;
  question?: string;
  capabilityId?: string;
  type?: string;
  expectedSymbols?: string[];
  expectedAssetType?: string | null;
  expectedTemplateId?: string | null;
  expectedDatasets?: string[];
  expectedRawFiles?: string[];
  expectedFinalFields?: string[];
  expectClarification?: boolean;
  visualCheck?: boolean;
}

export interface CreateQuantEvalSetInput {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  caseIds?: string[];
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
  evaluatorId: string;
  concurrency: number;
  mode: QuantEvalExecutionMode;
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

export type QuantEvalQueueStatus = QuantEvalQueueItem['status'];

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
  evaluatorId?: string;
  concurrency?: number;
  mode?: QuantEvalExecutionMode;
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
    mode: QuantEvalExecutionMode;
  };
  evaluator: {
    id: string;
    concurrency: number;
  };
  selection: {
    selectedCases: string[];
    limit: number | null;
    keepProjects: boolean;
    caseCount: number;
    concurrency: number;
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
