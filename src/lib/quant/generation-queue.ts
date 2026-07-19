import fs from "node:fs/promises";
import path from "node:path";

import type { AgentGenerationJob } from "@prisma/client";

import { withMoAgentWorkspaceResourceLock } from "@/lib/agent/runtime/workspace-resource-lock";
import { QUANT_GENERATION_QUEUE_RELATIVE_PATH } from "@/lib/quant/artifacts";
import {
  appendQuantWorkspaceEvent,
  ensureQuantWorkspace,
} from "@/lib/quant/workspace";
import {
  currentMoAgentGenerationDispatchFence,
  currentMoAgentGenerationDispatchSession,
  MoAgentGenerationDispatchSession,
} from "@/lib/services/moagent-generation-dispatch-session";
import {
  cancelMoAgentGenerationJob,
  finishMoAgentGenerationJob,
  listMoAgentGenerationJobs,
  listPendingMoAgentGenerationOutboxEvents,
  markMoAgentGenerationOutboxEventsPublished,
  reconcileExpiredMoAgentGenerationJobs,
  MoAgentGenerationDispatchError,
} from "@/lib/services/moagent-generation-dispatch-store";
import { withMoAgentGenerationLease } from "@/lib/services/moagent-generation-lease-session";
import type { MoAgentGenerationStage } from "@/lib/services/moagent-generation-lease-store";

export type QuantGenerationQueueStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface QuantGenerationQueueItem {
  id: string;
  projectId: string;
  requestId: string;
  status: QuantGenerationQueueStatus;
  cliPreference: string | null;
  selectedModel: string | null;
  instructionPreview: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface QuantGenerationQueueState {
  schemaVersion: 1;
  projectId: string;
  activeRequestId: string | null;
  updatedAt: string;
  items: QuantGenerationQueueItem[];
}

type QueueTask<T> = () => Promise<T>;

const MAX_QUEUE_ITEMS =
  Number.parseInt(
    process.env.QUANTPILOT_GENERATION_QUEUE_HISTORY_LIMIT ?? "",
    10,
  ) || 50;

export class QuantGenerationCancelledError extends Error {
  constructor(message = "生成任务已取消。") {
    super(message);
    this.name = "QuantGenerationCancelledError";
  }
}

function queuePath(projectPath: string) {
  return path.join(projectPath, QUANT_GENERATION_QUEUE_RELATIVE_PATH);
}

function projectionStatus(status: string): QuantGenerationQueueStatus {
  if (status === "pending" || status === "retry_wait") return "queued";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function projectJob(job: AgentGenerationJob): QuantGenerationQueueItem {
  return {
    id: job.id,
    projectId: job.projectId,
    requestId: job.requestId,
    status: projectionStatus(job.status),
    cliPreference: job.cliPreference,
    selectedModel: job.selectedModel,
    instructionPreview: job.instructionPreview,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
  };
}

async function writeProjection(
  projectPath: string,
  state: QuantGenerationQueueState,
): Promise<void> {
  await ensureQuantWorkspace(projectPath);
  const filePath = queuePath(projectPath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
}

/**
 * Materialize the PostgreSQL dispatch ledger into the generated workspace.
 * The JSON file is deliberately disposable: a failed or stale write is
 * repaired from jobs/outbox on the next read or lifecycle transition.
 */
async function projectDurableQueue(
  projectPath: string,
  projectId: string,
  options: { reconcileExpired?: boolean } = {},
): Promise<QuantGenerationQueueState> {
  if (options.reconcileExpired !== false) {
    await reconcileExpiredMoAgentGenerationJobs({ projectId });
  }
  const [jobs, pendingEvents] = await Promise.all([
    listMoAgentGenerationJobs(projectId, MAX_QUEUE_ITEMS),
    listPendingMoAgentGenerationOutboxEvents(projectId),
  ]);
  const items = jobs.map(projectJob);
  const state: QuantGenerationQueueState = {
    schemaVersion: 1,
    projectId,
    activeRequestId:
      items.find((item) => item.status === "running")?.requestId ?? null,
    updatedAt: jobs[0]?.updatedAt.toISOString() ?? new Date().toISOString(),
    items,
  };
  await writeProjection(projectPath, state);
  if (pendingEvents.length > 0) {
    await markMoAgentGenerationOutboxEventsPublished(
      pendingEvents.map((event) => event.id),
    );
  }
  return state;
}

async function appendLifecycleEvent(params: {
  projectPath: string;
  requestId: string;
  eventType: string;
  status: "pending" | "success" | "warning" | "error";
  summary: string;
}): Promise<void> {
  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: params.eventType,
    stage: "queue",
    status: params.status,
    run_id: params.requestId,
    artifact_path: QUANT_GENERATION_QUEUE_RELATIVE_PATH,
    summary: params.summary,
    created_at: new Date().toISOString(),
  });
}

export async function runQuantGenerationStage<T>(params: {
  projectPath: string;
  projectId: string;
  requestId?: string | null;
  stage: MoAgentGenerationStage;
  lockWorkspace?: boolean;
  task: QueueTask<T>;
}): Promise<T> {
  if (params.stage === "planning_data_prefetch") {
    await reconcileExpiredMoAgentGenerationJobs({
      projectId: params.projectId,
    });
  }
  return withMoAgentGenerationLease({
    projectId: params.projectId,
    requestId: params.requestId,
    stage: params.stage,
    task: async () => {
      if (!params.lockWorkspace) return params.task();
      return withMoAgentWorkspaceResourceLock(params.projectPath, params.task, {
        metadata: {
          purpose: "platform_generation",
          projectId: params.projectId,
          requestId: params.requestId ?? "unbound",
          operationId: params.stage,
        },
      });
    },
  });
}

interface QuantGenerationQueuedParams<T> {
  projectPath: string;
  projectId: string;
  requestId: string;
  instruction: string;
  cliPreference?: string | null;
  selectedModel?: string | null;
  executionEnvelope?: unknown;
  completeOnTaskSuccess?: boolean;
  completeOnTaskFailure?: boolean;
  task: QueueTask<T>;
}

async function prepareQuantGenerationDispatch<T>(
  params: QuantGenerationQueuedParams<T>,
): Promise<MoAgentGenerationDispatchSession> {
  let dispatch: MoAgentGenerationDispatchSession;
  try {
    dispatch = await MoAgentGenerationDispatchSession.enqueueAndClaim({
      projectId: params.projectId,
      requestId: params.requestId,
      instruction: params.instruction,
      cliPreference: params.cliPreference,
      selectedModel: params.selectedModel,
      executionEnvelope: params.executionEnvelope,
    });
  } catch (error) {
    if (
      error instanceof MoAgentGenerationDispatchError &&
      error.code === "GENERATION_DISPATCH_CANCELLED"
    ) {
      await projectDurableQueue(params.projectPath, params.projectId, {
        reconcileExpired: false,
      }).catch(() => undefined);
      throw new QuantGenerationCancelledError(error.message);
    }
    throw error;
  }
  try {
    await projectDurableQueue(params.projectPath, params.projectId, {
      reconcileExpired: false,
    });
    await appendLifecycleEvent({
      projectPath: params.projectPath,
      requestId: params.requestId,
      eventType: "generation_queued",
      status: "pending",
      summary: "生成任务已进入 PostgreSQL durable dispatch。",
    });
    await appendLifecycleEvent({
      projectPath: params.projectPath,
      requestId: params.requestId,
      eventType: "generation_queue_started",
      status: "pending",
      summary: `生成任务由 durable worker claim（attempt ${dispatch.claim.attemptCount}）。`,
    });
    return dispatch;
  } catch (error) {
    await finishMoAgentGenerationJob({
      projectId: params.projectId,
      requestId: params.requestId,
      status: "failed",
      errorCode: "GENERATION_DISPATCH_ACCEPTANCE_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      fence: dispatch.fence,
    }).catch(() => undefined);
    dispatch.dispose();
    throw error;
  }
}

async function executeQuantGenerationDispatch<T>(
  params: QuantGenerationQueuedParams<T>,
  dispatch: MoAgentGenerationDispatchSession,
): Promise<T> {
  try {
    const result = await withMoAgentGenerationLease({
      projectId: params.projectId,
      requestId: params.requestId,
      stage: "agent_execution",
      task: () => dispatch.run(params.task),
    });
    dispatch.assertHealthy();
    if (params.completeOnTaskSuccess !== false) {
      await dispatch.run(() =>
        finishQuantGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "completed",
        }),
      );
    }
    return result;
  } catch (error) {
    await dispatch
      .run(() =>
        finishQuantGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      )
      .catch((finishError) => {
        if (
          params.completeOnTaskFailure !== false &&
          process.env.NODE_ENV !== "test"
        ) {
          console.error(
            "[GenerationDispatch] Failed to persist task failure:",
            finishError,
          );
        }
      });
    throw error;
  } finally {
    dispatch.dispose();
    await projectDurableQueue(params.projectPath, params.projectId).catch(
      () => undefined,
    );
  }
}

/**
 * Persist and claim before returning control to the HTTP request, then expose
 * a separately awaitable completion for the background lifecycle.
 */
export async function startQuantGenerationQueued<T>(
  params: QuantGenerationQueuedParams<T>,
): Promise<{ completion: Promise<T> }> {
  const dispatch = await prepareQuantGenerationDispatch(params);
  return { completion: executeQuantGenerationDispatch(params, dispatch) };
}

export async function runQuantGenerationQueued<T>(
  params: QuantGenerationQueuedParams<T>,
): Promise<T> {
  const started = await startQuantGenerationQueued(params);
  return started.completion;
}

export async function finishQuantGenerationQueueItem(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  status: Exclude<QuantGenerationQueueStatus, "queued" | "running">;
  errorMessage?: string | null;
}) {
  if (params.status === "cancelled") {
    return markQuantGenerationQueueCancelled({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      reason: params.errorMessage,
    });
  }
  currentMoAgentGenerationDispatchSession()?.assertHealthy();
  const job = await finishMoAgentGenerationJob({
    projectId: params.projectId,
    requestId: params.requestId,
    status: params.status,
    errorCode: params.status === "failed" ? "GENERATION_FAILED" : null,
    errorMessage: params.errorMessage,
    fence: currentMoAgentGenerationDispatchFence(),
  });
  await projectDurableQueue(params.projectPath, params.projectId, {
    reconcileExpired: false,
  });
  await appendLifecycleEvent({
    projectPath: params.projectPath,
    requestId: params.requestId,
    eventType: "generation_queue_finished",
    status: params.status === "completed" ? "success" : "error",
    summary:
      params.status === "completed"
        ? "生成任务执行完成。"
        : `生成任务失败：${params.errorMessage ?? "未知错误"}`,
  });
  currentMoAgentGenerationDispatchSession()?.markTerminal();
  return job;
}

export async function markQuantGenerationQueueCancelled(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  reason?: string | null;
}) {
  const job = await cancelMoAgentGenerationJob({
    projectId: params.projectId,
    requestId: params.requestId,
    reason: params.reason,
  });
  if (!job) return null;
  await projectDurableQueue(params.projectPath, params.projectId, {
    reconcileExpired: false,
  });
  await appendLifecycleEvent({
    projectPath: params.projectPath,
    requestId: params.requestId,
    eventType: "generation_queue_finished",
    status: "warning",
    summary: "生成任务已取消。",
  });
  currentMoAgentGenerationDispatchSession()?.markTerminal();
  return job;
}

export async function readQuantGenerationQueue(
  projectPath: string,
  projectId: string,
) {
  return projectDurableQueue(projectPath, projectId);
}

export async function updateQuantGenerationQueueItem(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  patch: Partial<QuantGenerationQueueItem>;
}) {
  // Compatibility surface: business state is no longer mutable through the
  // workspace projection. Re-materialize the authoritative database state.
  void params.requestId;
  void params.patch;
  return projectDurableQueue(params.projectPath, params.projectId);
}
