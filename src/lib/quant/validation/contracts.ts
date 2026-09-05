

export type QuantValidationCheckStatus = 'passed' | 'failed' | 'warning';

export type QuantValidationStatus = 'passed' | 'failed';

export interface QuantValidationCheck {
  id: string;
  name: string;
  status: QuantValidationCheckStatus;
  summary: string;
  details?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface QuantValidationReport {
  schemaVersion: 1;
  runId?: string;
  status: QuantValidationStatus;
  passed: boolean;
  projectId: string;
  reportPath: string;
  checks: QuantValidationCheck[];
  createdAt: string;
  updatedAt: string;
}

export type QuantValidationStaleReason =
  | 'artifact_modified_after_report'
  | 'run_id_mismatch';

export interface QuantValidationArtifactMtime {
  path: string;
  mtimeMs: number;
}

export interface QuantValidationFreshness {
  stale: boolean;
  reasons: QuantValidationStaleReason[];
  staleArtifactPaths: string[];
  newestArtifactMtimeMs: number | null;
  reportRunId: string | null;
  currentRunId: string | null;
}

export interface QuantValidationRepairStep {
  checkId: string;
  checkName: string;
  summary: string;
  actions: string[];
  details?: string;
}

export interface QuantValidationRepairPlan {
  schemaVersion: 1;
  status: 'needed';
  projectId: string;
  reportPath: string;
  repairPlanPath: string;
  steps: QuantValidationRepairStep[];
  createdAt: string;
}

export interface QuantDashboardTemplateRestoreResult {
  restored: boolean;
  reason: string;
  failedCheckIds: string[];
}

export interface ValidateQuantProjectParams {
  projectId: string;
  projectPath: string;
  requestId?: string | null;
  conversationId?: string | null;
  cliSource?: string | null;
}

export interface PrepareQuantProjectForValidationParams {
  projectId: string;
  projectPath: string;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
}

export const VALIDATION_REPORT_RELATIVE_PATH = '.data-agent/validation.json';

export const VALIDATION_REPAIR_PLAN_RELATIVE_PATH = '.data-agent/validation-repair-plan.json';

export const VALIDATION_STALE_ARTIFACT_PATHS = [
  '.data-agent/finance-run-plan.json',
  'app/page.tsx',
  'app/globals.css',
  'app/layout.tsx',
  'app/api/market/[...path]/route.ts',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data_quality.json',
  'evidence/image_extraction.json',
  'package.json',
];
