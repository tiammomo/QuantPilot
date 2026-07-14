export interface AgentExecutionResultLike {
  id?: string;
  agentExecuted?: boolean;
  agentExecution?: {
    executed?: boolean;
    provider?: string | null;
    model?: string | null;
    requestId?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  } | null;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function isE2eAgentExecutionAttested(result: AgentExecutionResultLike): boolean {
  const execution = result.agentExecution;
  return Boolean(
    result.agentExecuted === true &&
    execution?.executed === true &&
    nonEmptyString(execution.provider) &&
    nonEmptyString(execution.model) &&
    nonEmptyString(execution.requestId) &&
    nonEmptyString(execution.startedAt) &&
    nonEmptyString(execution.completedAt),
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
