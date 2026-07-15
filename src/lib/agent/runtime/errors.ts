export type AgentRuntimeRepositoryErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LEASE_LOST'
  | 'WORKSPACE_BUSY'
  | 'WORKSPACE_BINDING_CONFLICT'
  | 'RECONCILIATION_REQUIRED'
  | 'INVALID_STATE'
  | 'OPERATION_CONFLICT';

export class AgentRuntimeRepositoryError extends Error {
  constructor(
    public readonly code: AgentRuntimeRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AgentRuntimeRepositoryError';
  }
}
