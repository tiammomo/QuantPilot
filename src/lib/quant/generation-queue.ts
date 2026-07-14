import fs from 'fs/promises';
import path from 'path';
import { QUANT_GENERATION_QUEUE_RELATIVE_PATH } from '@/lib/quant/artifacts';
import { appendQuantWorkspaceEvent, ensureQuantWorkspace } from '@/lib/quant/workspace';

export type QuantGenerationQueueStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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

const MAX_QUEUE_ITEMS = Number.parseInt(process.env.QUANTPILOT_GENERATION_QUEUE_HISTORY_LIMIT ?? '', 10) || 50;
const projectLocks = new Map<string, Promise<void>>();
const queueStateLocks = new Map<string, Promise<void>>();

export class QuantGenerationCancelledError extends Error {
  constructor(message = '生成任务已取消。') {
    super(message);
    this.name = 'QuantGenerationCancelledError';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function queuePath(projectPath: string) {
  return path.join(projectPath, QUANT_GENERATION_QUEUE_RELATIVE_PATH);
}

function previewInstruction(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

async function readQueue(projectPath: string, projectId: string): Promise<QuantGenerationQueueState> {
  const content = await fs.readFile(queuePath(projectPath), 'utf8').catch(() => null);
  if (content) {
    try {
      const parsed = JSON.parse(content) as QuantGenerationQueueState;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
        return {
          schemaVersion: 1,
          projectId: parsed.projectId || projectId,
          activeRequestId: parsed.activeRequestId ?? null,
          updatedAt: parsed.updatedAt || nowIso(),
          items: parsed.items,
        };
      }
    } catch {
      // Regenerate malformed queue state below.
    }
  }

  return {
    schemaVersion: 1,
    projectId,
    activeRequestId: null,
    updatedAt: nowIso(),
    items: [],
  };
}

async function writeQueue(projectPath: string, state: QuantGenerationQueueState) {
  await ensureQuantWorkspace(projectPath);
  const filePath = queuePath(projectPath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

async function withQueueStateLock<T>(projectPath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectPath);
  const previous = queueStateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  queueStateLocks.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (queueStateLocks.get(key) === queued) {
      queueStateLocks.delete(key);
    }
  }
}

async function withProjectGenerationLock<T>(projectId: string, task: QueueTask<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  projectLocks.set(projectId, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (projectLocks.get(projectId) === queued) {
      projectLocks.delete(projectId);
    }
  }
}

function patchItem(
  state: QuantGenerationQueueState,
  requestId: string,
  patch: Partial<QuantGenerationQueueItem>
): QuantGenerationQueueState {
  let found = false;
  const items = state.items.map((item) => {
    if (item.requestId !== requestId) return item;
    found = true;
    return { ...item, ...patch };
  });
  return {
    ...state,
    updatedAt: nowIso(),
    items: (found ? items : state.items).slice(0, MAX_QUEUE_ITEMS),
  };
}

async function updateQueueItem(
  projectPath: string,
  projectId: string,
  requestId: string,
  patch: Partial<QuantGenerationQueueItem>
) {
  return withQueueStateLock(projectPath, async () => {
    const state = await readQueue(projectPath, projectId);
    const nextState = patchItem(state, requestId, patch);
    await writeQueue(projectPath, nextState);
    return nextState;
  });
}

async function enqueueItem(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  instruction: string;
  cliPreference?: string | null;
  selectedModel?: string | null;
}) {
  const timestamp = nowIso();
  const item = await withQueueStateLock(params.projectPath, async () => {
    const state = await readQueue(params.projectPath, params.projectId);
    const existing = state.items.find((entry) => entry.requestId === params.requestId);
    if (existing?.status === 'cancelled') {
      return existing;
    }
    const nextItem: QuantGenerationQueueItem = {
      id: existing?.id ?? `${params.projectId}:${params.requestId}`,
      projectId: params.projectId,
      requestId: params.requestId,
      status: 'queued',
      cliPreference: params.cliPreference ?? null,
      selectedModel: params.selectedModel ?? null,
      instructionPreview: previewInstruction(params.instruction),
      queuedAt: existing?.queuedAt ?? timestamp,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
    };
    const items = [nextItem, ...state.items.filter((entry) => entry.requestId !== params.requestId)].slice(0, MAX_QUEUE_ITEMS);
    await writeQueue(params.projectPath, {
      ...state,
      updatedAt: timestamp,
      items,
    });
    return nextItem;
  });
  if (item.status === 'cancelled') {
    return item;
  }
  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: 'generation_queued',
    stage: 'queue',
    status: 'pending',
    run_id: params.requestId,
    artifact_path: QUANT_GENERATION_QUEUE_RELATIVE_PATH,
    summary: '生成任务已进入项目队列。',
    created_at: timestamp,
  });
  return item;
}

async function markRunning(projectPath: string, projectId: string, requestId: string) {
  const timestamp = nowIso();
  const started = await withQueueStateLock(projectPath, async () => {
    const state = await readQueue(projectPath, projectId);
    const item = state.items.find((entry) => entry.requestId === requestId);
    if (!item || item.status === 'cancelled') return false;
    const nextState = patchItem(
      { ...state, activeRequestId: requestId },
      requestId,
      { status: 'running', startedAt: timestamp, completedAt: null, errorMessage: null }
    );
    await writeQueue(projectPath, nextState);
    return true;
  });
  if (!started) return false;
  await appendQuantWorkspaceEvent(projectPath, {
    event_type: 'generation_queue_started',
    stage: 'queue',
    status: 'pending',
    run_id: requestId,
    artifact_path: QUANT_GENERATION_QUEUE_RELATIVE_PATH,
    summary: '生成任务开始执行。',
    created_at: timestamp,
  });
  return true;
}

async function markFinished(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  status: Exclude<QuantGenerationQueueStatus, 'queued' | 'running'>;
  errorMessage?: string | null;
}) {
  const timestamp = nowIso();
  const changed = await withQueueStateLock(params.projectPath, async () => {
    const state = await readQueue(params.projectPath, params.projectId);
    const existing = state.items.find((item) => item.requestId === params.requestId);
    if (existing?.status === 'cancelled' && params.status !== 'cancelled') {
      return false;
    }
    const baseState = existing
      ? state
      : {
          ...state,
          items: [
            {
              id: `${params.projectId}:${params.requestId}`,
              projectId: params.projectId,
              requestId: params.requestId,
              status: params.status,
              cliPreference: null,
              selectedModel: null,
              instructionPreview: '',
              queuedAt: timestamp,
              startedAt: null,
              completedAt: timestamp,
              errorMessage: params.errorMessage ?? null,
            },
            ...state.items,
          ].slice(0, MAX_QUEUE_ITEMS),
        };
    const nextState = patchItem(
      {
        ...baseState,
        activeRequestId: baseState.activeRequestId === params.requestId ? null : baseState.activeRequestId,
      },
      params.requestId,
      {
        status: params.status,
        completedAt: timestamp,
        errorMessage: params.errorMessage ?? null,
      }
    );
    await writeQueue(params.projectPath, nextState);
    return true;
  });
  if (!changed) return false;
  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: 'generation_queue_finished',
    stage: 'queue',
    status: params.status === 'completed' ? 'success' : params.status === 'cancelled' ? 'warning' : 'error',
    run_id: params.requestId,
    artifact_path: QUANT_GENERATION_QUEUE_RELATIVE_PATH,
    summary: params.status === 'completed'
      ? '生成任务执行完成。'
      : params.status === 'cancelled'
        ? '生成任务已取消。'
        : `生成任务失败：${params.errorMessage ?? '未知错误'}`,
    created_at: timestamp,
  });
  return true;
}

export async function runQuantGenerationStageLocked<T>(params: {
  projectId: string;
  task: QueueTask<T>;
}): Promise<T> {
  return withProjectGenerationLock(params.projectId, params.task);
}

export async function runQuantGenerationQueued<T>(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  instruction: string;
  cliPreference?: string | null;
  selectedModel?: string | null;
  completeOnTaskSuccess?: boolean;
  completeOnTaskFailure?: boolean;
  task: QueueTask<T>;
}): Promise<T> {
  const enqueued = await enqueueItem(params);
  return withProjectGenerationLock(params.projectId, async () => {
    if (enqueued.status === 'cancelled' || !(await markRunning(params.projectPath, params.projectId, params.requestId))) {
      throw new QuantGenerationCancelledError(enqueued.errorMessage ?? '生成任务已取消。');
    }
    try {
      const result = await params.task();
      if (params.completeOnTaskSuccess !== false) {
        await markFinished({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: 'completed',
        });
      }
      return result;
    } catch (error) {
      const current = await readQueue(params.projectPath, params.projectId);
      const cancelled = current.items.find((item) => item.requestId === params.requestId)?.status === 'cancelled';
      if (!cancelled && params.completeOnTaskFailure !== false) {
        await markFinished({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } else if (!cancelled) {
        await updateQueueItem(params.projectPath, params.projectId, params.requestId, {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  });
}

export async function finishQuantGenerationQueueItem(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  status: Exclude<QuantGenerationQueueStatus, 'queued' | 'running'>;
  errorMessage?: string | null;
}) {
  return markFinished(params);
}

export async function markQuantGenerationQueueCancelled(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  reason?: string | null;
}) {
  await markFinished({
    projectPath: params.projectPath,
    projectId: params.projectId,
    requestId: params.requestId,
    status: 'cancelled',
    errorMessage: params.reason ?? '用户暂停了当前任务',
  });
}

export async function readQuantGenerationQueue(projectPath: string, projectId: string) {
  return readQueue(projectPath, projectId);
}

export async function updateQuantGenerationQueueItem(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  patch: Partial<QuantGenerationQueueItem>;
}) {
  return updateQueueItem(params.projectPath, params.projectId, params.requestId, params.patch);
}
