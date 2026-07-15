import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY = '.moagent-workspace.lock';
const OWNER_FILE = 'owner.json';
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 50;

export class MoAgentWorkspaceResourceLockError extends Error {
  constructor(
    readonly code: 'WORKSPACE_RESOURCE_LOCKED' | 'WORKSPACE_RESOURCE_LOCK_LOST',
    message: string
  ) {
    super(message);
    this.name = 'MoAgentWorkspaceResourceLockError';
  }
}

export interface MoAgentWorkspaceResourceLockOptions {
  signal?: AbortSignal;
  waitTimeoutMs?: number;
  retryIntervalMs?: number;
  ownerId?: string;
  now?: () => number;
  metadata?: {
    purpose:
      | 'run_startup'
      | 'workspace_write'
      | 'platform_generation'
      | 'mission_evidence_verification'
      | 'other';
    projectId?: string;
    requestId?: string;
    runId?: string;
    operationId?: string;
    missionId?: string;
    generationId?: string;
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function boundedOwnerValue(value: string, label: string, maxBytes = 512): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > maxBytes ||
    /[\r\n\0]/.test(normalized)
  ) {
    throw new Error(`${label} must be non-empty, bounded, and contain no control characters.`);
  }
  return normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Workspace resource lock acquisition was aborted.', 'AbortError');
  }
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Workspace resource lock acquisition was aborted.', 'AbortError')
      );
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function readOwnerId(lockPath: string): Promise<string | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8')) as unknown;
    return value && typeof value === 'object' && 'ownerId' in value &&
      typeof (value as { ownerId?: unknown }).ownerId === 'string'
      ? (value as { ownerId: string }).ownerId
      : null;
  } catch {
    return null;
  }
}

/**
 * Serializes physical workspace mutation and DB lease takeover on the shared
 * filesystem itself. Lock directories are deliberately never auto-broken:
 * after a process crash, an operator must reconcile the workspace and remove
 * the orphan lock explicitly. That sacrifices availability instead of letting
 * a paused old worker write after a new fencing owner takes over.
 */
export async function withMoAgentWorkspaceResourceLock<T>(
  workspaceRoot: string,
  operation: () => Promise<T>,
  options: MoAgentWorkspaceResourceLockOptions = {}
): Promise<T> {
  const waitTimeoutMs = positiveInteger(
    options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    'workspace resource lock waitTimeoutMs'
  );
  const retryIntervalMs = positiveInteger(
    options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
    'workspace resource lock retryIntervalMs'
  );
  const now = options.now ?? Date.now;
  const ownerId = boundedOwnerValue(
    options.ownerId ?? `resource:${process.pid}:${randomUUID()}`,
    'workspace resource lock ownerId'
  );
  const hostname = boundedOwnerValue(os.hostname(), 'workspace resource lock hostname', 256);
  const instanceId = boundedOwnerValue(
    process.env.MOAGENT_INSTANCE_ID?.trim() || `${hostname}:${process.pid}`,
    'MOAGENT_INSTANCE_ID',
    256
  );
  const metadata = options.metadata
    ? Object.fromEntries(Object.entries(options.metadata).map(([key, value]) => [
        key,
        boundedOwnerValue(value, `workspace resource lock metadata.${key}`),
      ]))
    : {};
  const canonicalRoot = await fs.realpath(path.resolve(workspaceRoot));
  if (!(await fs.stat(canonicalRoot)).isDirectory()) {
    throw new Error('MoAgent workspace resource lock root must be a directory.');
  }
  const lockPath = path.join(canonicalRoot, MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY);
  const deadline = now() + waitTimeoutMs;
  let acquired = false;
  let ownerWritten = false;

  while (!acquired) {
    throwIfAborted(options.signal);
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (now() >= deadline) {
        throw new MoAgentWorkspaceResourceLockError(
          'WORKSPACE_RESOURCE_LOCKED',
          'Workspace physical mutation lock is held or requires manual reconciliation.'
        );
      }
      await delay(Math.min(retryIntervalMs, Math.max(1, deadline - now())), options.signal);
    }
  }

  try {
    await fs.writeFile(
      path.join(lockPath, OWNER_FILE),
      `${JSON.stringify({
        schemaVersion: 2,
        ownerId,
        pid: process.pid,
        hostname,
        instanceId,
        acquiredAt: new Date(now()).toISOString(),
        ...metadata,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    ownerWritten = true;
    return await operation();
  } finally {
    if (!ownerWritten) {
      await fs.rm(lockPath, { recursive: true, force: true });
    } else if (await readOwnerId(lockPath) === ownerId) {
      await fs.rm(lockPath, { recursive: true, force: true });
    } else {
      throw new MoAgentWorkspaceResourceLockError(
        'WORKSPACE_RESOURCE_LOCK_LOST',
        'Workspace resource lock ownership changed while the operation was running.'
      );
    }
  }
}
