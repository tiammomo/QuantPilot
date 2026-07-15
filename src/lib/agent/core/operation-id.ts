import { createHash } from 'node:crypto';

import type { MoAgentToolCall } from '../types';

/**
 * Derive a ledger identity from framework-owned run/turn framing. The model's
 * tool-call ID contributes to the digest but never becomes a database key.
 */
export function createMoAgentOperationId(
  runId: string,
  turn: number,
  toolCall: Pick<MoAgentToolCall, 'id' | 'name'>
): string {
  const digest = createHash('sha256')
    .update(runId)
    .update('\0')
    .update(String(turn))
    .update('\0')
    .update(toolCall.id)
    .update('\0')
    .update(toolCall.name)
    .digest('hex');
  return `op_${digest}`;
}
