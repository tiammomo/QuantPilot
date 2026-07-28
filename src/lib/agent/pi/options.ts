import type { PiAgentContextManager } from '../context';
import type {
  PiAgentModelProvider,
  PiAgentTool,
  PiAgentToolApprovalHandler,
} from '../types';

export interface PiAgentRunEngineOptions {
  provider: PiAgentModelProvider;
  model: string;
  tools?: readonly PiAgentTool[];
  maxTurns?: number;
  maxTokens?: number;
  /** Provider output cap for one turn; maxTokens remains the cumulative run cap. */
  maxTokensPerTurn?: number;
  /**
   * Optional cumulative provider-reported input-token budget. Crossing the
   * budget prevents the next model request rather than discarding a completed
   * current turn.
   */
  maxRunInputTokens?: number;
  /**
   * Optional cumulative provider-reported cache-miss input-token budget.
   * Missing cache telemetry is charged as a cache miss.
   */
  maxRunCacheMissInputTokens?: number;
  /** Hard cumulative pre-request budget over estimated prepared provider input. */
  maxRunPreparedInputTokens?: number;
  /** Consecutive tool turns without verifiable progress before convergence. */
  progressStallTurns?: number;
  /** Read-only turns allowed before the first successful workspace write. */
  preWriteReadOnlyTurnThreshold?: number;
  /** Read-only turns allowed after a successful workspace write. */
  postWriteReadOnlyTurnThreshold?: number;
  /** Require at least one workspace write before a terminal tool may complete. */
  requireWorkspaceWriteBeforeTerminal?: boolean;
  timeoutMs?: number;
  maxToolCallsPerTurn?: number;
  maxTotalToolCalls?: number;
  maxTextCharsPerTurn?: number;
  maxReasoningCharsPerTurn?: number;
  maxToolArgumentChars?: number;
  /** Maximum time spent awaiting one event consumer. */
  eventHandlerTimeoutMs?: number;
  /** Extra bounded window for durable terminal writes after cancellation. */
  criticalDrainTimeoutMs?: number;
  /** Per best-effort observer timeout. */
  observerTimeoutMs?: number;
  /** Optional deterministic context preparation before every provider request. */
  contextManager?: Pick<PiAgentContextManager, 'prepare'> &
    Partial<Pick<PiAgentContextManager, 'createCapsuleSession'>>;
  /** Defaults to true when at least one registered tool is terminal. */
  requireTerminalTool?: boolean;
  /** Application-owned resolver for tools with an explicit approval policy. */
  toolApprovalHandler?: PiAgentToolApprovalHandler;
  idFactory?: () => string;
  now?: () => number;
}
