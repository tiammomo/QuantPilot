export type EvalTraceStageId = 'intent' | 'planning' | 'data' | 'artifact' | 'visual' | 'runtime' | 'acceptance';
export type EvalTraceStageStatus = 'passed' | 'warning' | 'failed' | 'unknown';

export interface EvalTraceStage {
  id: EvalTraceStageId;
  label: string;
  status: EvalTraceStageStatus;
  signals: string[];
}

export interface EvalTraceDiagnostics {
  schemaVersion: 1;
  primaryFailureStage: EvalTraceStageId | null;
  stages: EvalTraceStage[];
  observedEventStages: string[];
}

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};

function checksFromResult(result: UnknownRecord): UnknownRecord[] {
  const validation = record(result.validation);
  if (Array.isArray(validation.checks)) return validation.checks.map(record);
  if (Array.isArray(result.validationChecks)) return result.validationChecks.map(record);
  return [];
}

function stageFromChecks(
  checks: UnknownRecord[],
  ids: string[],
  fallback: EvalTraceStageStatus = 'unknown',
): { status: EvalTraceStageStatus; signals: string[] } {
  const selected = checks.filter((check) => ids.includes(String(check.id ?? '')));
  const signals = selected.map((check) => `${String(check.id)}:${String(check.status ?? 'unknown')}`);
  if (selected.some((check) => check.status === 'failed')) return { status: 'failed', signals };
  if (selected.some((check) => check.status === 'warning' || check.status === 'unknown')) {
    return { status: 'warning', signals };
  }
  if (selected.length > 0) return { status: 'passed', signals };
  return { status: fallback, signals };
}

export function buildEvalTraceDiagnostics(
  value: unknown,
  mode: 'contract' | 'e2e',
): EvalTraceDiagnostics {
  const result = record(value);
  const checks = checksFromResult(result);
  const failures = Array.isArray(result.failures) ? result.failures.map(String) : [];
  const artifacts = record(result.artifacts);
  const oracle = record(artifacts.oracle);
  const visual = record(result.visualCheck);
  const eventAudit = record(result.eventAudit);
  const execution = record(result.agentExecution);
  const tools = record(execution.tools);
  const observedEventStages = Array.isArray(eventAudit.stages)
    ? eventAudit.stages.map(String)
    : [];

  const intentFailure = failures.some((failure) => /澄清|意图|symbol|标的/u.test(failure));
  const intentChecks = stageFromChecks(checks, ['intent_clarification', 'clarification_continuation']);
  const intentStatus = intentFailure ? 'failed' : intentChecks.status === 'unknown' ? 'passed' : intentChecks.status;
  const planningSignals = [
    ...observedEventStages.filter((stage) => /plan|规划|mission/iu.test(stage)).map((stage) => `event:${stage}`),
  ];
  const planningStatus: EvalTraceStageStatus = failures.some((failure) => /run_plan|规划|plan/iu.test(failure))
    ? 'failed'
    : planningSignals.length > 0 || result.prefetch != null
      ? 'passed'
      : 'unknown';
  const dataChecks = stageFromChecks(checks, ['final_data_file', 'evidence_files', 'market_proxy']);
  const dataStatus: EvalTraceStageStatus = oracle.passed === false
    ? 'failed'
    : oracle.warning === true
      ? 'warning'
      : dataChecks.status;
  const artifactStage = stageFromChecks(checks, [
    'artifact_policy', 'next_build', 'preview_http_200', 'artifact_contracts', 'dashboard_data_binding', 'chart_presence',
  ]);
  const visualChecks = stageFromChecks(checks, ['visual_presentation']);
  const visualStatus: EvalTraceStageStatus = result.visualCheck == null
    ? visualChecks.status
    : visual.passed === true ? 'passed' : 'failed';
  const unexpectedToolFailures = Number(tools.unexpectedFailureCount ?? 0);
  const eventErrors = Number(eventAudit.errorCount ?? 0);
  const eventWarnings = Number(eventAudit.warningCount ?? 0);
  const runtimeStatus: EvalTraceStageStatus = unexpectedToolFailures > 0 || eventErrors > 0
    ? 'failed'
    : eventWarnings > 0
      ? 'warning'
      : 'passed';
  const acceptanceStatus: EvalTraceStageStatus = mode === 'contract'
    ? 'passed'
    : execution.executed === true && execution.acceptedReceiptId &&
        (execution.missionStatus === 'accepted' || execution.missionStatus === 'completed')
      ? 'passed'
      : 'failed';

  const stages: EvalTraceStage[] = [
    { id: 'intent', label: '意图与标的', status: intentStatus, signals: [...intentChecks.signals, ...failures.filter((item) => /澄清|意图|symbol|标的/u.test(item)).slice(0, 5)] },
    { id: 'planning', label: '规划', status: planningStatus, signals: planningSignals },
    { id: 'data', label: '数据与事实', status: dataStatus, signals: [...dataChecks.signals, ...(oracle.passed === false ? ['oracle:failed'] : [])] },
    { id: 'artifact', label: '产物与构建', status: artifactStage.status, signals: artifactStage.signals },
    { id: 'visual', label: '视觉交付', status: visualStatus, signals: visualChecks.signals },
    { id: 'runtime', label: '运行可靠性', status: runtimeStatus, signals: [`eventErrors:${eventErrors}`, `eventWarnings:${eventWarnings}`, `unexpectedToolFailures:${unexpectedToolFailures}`] },
    { id: 'acceptance', label: 'Mission 验收', status: acceptanceStatus, signals: mode === 'e2e' ? [`mission:${String(execution.missionStatus ?? 'missing')}`] : ['contract:no-live-mission'] },
  ];
  return {
    schemaVersion: 1,
    primaryFailureStage: stages.find((stage) => stage.status === 'failed')?.id ?? null,
    stages,
    observedEventStages,
  };
}
