import { createHash } from 'node:crypto';
import { serializeMessage } from '@/lib/serializers/chat';
import { ensureMessage } from '@/lib/services/message';
import { collectMoAgentTurnMetrics } from '@/lib/services/moagent-turn-metrics';
import { streamManager } from '@/lib/services/stream';
import {
  buildWorkspaceProgressMessage,
  WORKSPACE_PROGRESS_TOTAL,
  type WorkspaceProgressOptions,
} from '@/lib/quant/workspace-response';

export type WorkspaceProgressPublisher = (
  options: WorkspaceProgressOptions,
) => Promise<void>;

export function workspaceProgressMessageId(
  projectId: string,
  requestId: string,
  stage: number,
): string {
  const digest = createHash('sha256')
    .update(projectId)
    .update('\0')
    .update(requestId)
    .update('\0')
    .update(String(stage))
    .digest('hex')
    .slice(0, 32);
  return `workspace-progress-${digest}`;
}

export function createWorkspaceProgressPublisher(params: {
  projectId: string;
  requestId: string;
  conversationId?: string | null;
  cliSource?: string | null;
  relatedAgentRequestIds?: ReadonlySet<string>;
}): WorkspaceProgressPublisher {
  const publishedStages = new Set<number>();

  return async (options) => {
    if (publishedStages.has(options.stage)) return;

    try {
      const successfulFinal = options.stage === 5 &&
        !options.failureReason &&
        !options.cancelledReason;
      const turnMetrics = options.stage === 5
        ? await collectMoAgentTurnMetrics({
            projectId: params.projectId,
            requestId: params.requestId,
            relatedRequestIds: params.relatedAgentRequestIds,
          }).catch((error) => {
            // Metrics are an observability projection. They must never turn an
            // accepted/failed/cancelled Mission into a different business state.
            console.error('[WorkspaceProgress] Failed to collect turn metrics:', error);
            return null;
          })
        : null;
      const message = await ensureMessage({
        id: workspaceProgressMessageId(
          params.projectId,
          params.requestId,
          options.stage,
        ),
        projectId: params.projectId,
        role: 'assistant',
        messageType: 'chat',
        content: buildWorkspaceProgressMessage(options),
        conversationId: params.conversationId ?? undefined,
        cliSource: params.cliSource ?? undefined,
        metadata: {
          isWorkspaceProgress: true,
          progressStep: options.stage,
          progressTotal: WORKSPACE_PROGRESS_TOTAL,
          progressStatus: options.stage === 5
            ? successfulFinal
              ? 'completed'
              : options.cancelledReason ? 'cancelled' : 'failed'
            : 'running',
          ...(options.stage < 5 ? { isMissionIntermediate: true } : {}),
          ...(options.stage === 5 ? { isMissionFinal: true } : {}),
          ...(turnMetrics ? { turnMetrics } : {}),
          ...(successfulFinal
            ? {
                isMoAgentFinal: true,
                validationPassed: true,
              }
            : {}),
        },
        requestId: params.requestId,
      });
      publishedStages.add(options.stage);
      streamManager.publish(params.projectId, {
        type: 'message',
        data: serializeMessage(message, { requestId: params.requestId }),
      });
    } catch (error) {
      // Progress narration must never change the financial task's durable
      // outcome. A later lifecycle/status event remains authoritative.
      console.error(
        `[WorkspaceProgress] Failed to publish stage ${options.stage}:`,
        error,
      );
    }
  };
}
