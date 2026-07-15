import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY = '.moagent-workspace.lock';
const OWNER_FILE = 'owner.json';
const RECOVERY_CLAIM_FILE = '.recovery-claim.json';
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
  /**
   * Startup recovery may quarantine a schema-v2 lock only when its owner is
   * on this hostname and its PID is provably absent. Remote/ambiguous owners
   * remain fail-closed.
   */
  recoverDeadLocalOwner?: boolean;
  /** @internal Deterministic concurrency hooks used by the lock regression tests. */
  recoveryTestHooks?: {
    afterDeadOwnerObserved?: () => Promise<void>;
  };
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

interface WorkspaceResourceLockOwner {
  schemaVersion: 2;
  ownerId: string;
  pid: number;
  hostname: string;
}

interface WorkspaceResourceLockOwnerObservation {
  owner: WorkspaceResourceLockOwner;
  device: bigint;
  inode: bigint;
}

interface WorkspaceResourceLockRecoveryClaim {
  schemaVersion: 1;
  claimId: string;
  claimantPid: number;
  claimantHostname: string;
  targetOwner: WorkspaceResourceLockOwner;
  targetDevice: string;
  targetInode: string;
}

async function readOwner(lockPath: string): Promise<WorkspaceResourceLockOwner | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const owner = value as Record<string, unknown>;
    return owner.schemaVersion === 2 &&
      typeof owner.ownerId === 'string' && owner.ownerId.length > 0 &&
      Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 &&
      typeof owner.hostname === 'string' && owner.hostname.length > 0
      ? {
          schemaVersion: 2,
          ownerId: owner.ownerId,
          pid: Number(owner.pid),
          hostname: owner.hostname,
        }
      : null;
  } catch {
    return null;
  }
}

async function readOwnerId(lockPath: string): Promise<string | null> {
  return (await readOwner(lockPath))?.ownerId ?? null;
}

async function observeOwner(
  lockPath: string
): Promise<WorkspaceResourceLockOwnerObservation | null> {
  const owner = await readOwner(lockPath);
  if (!owner) return null;
  try {
    const stat = await fs.stat(path.join(lockPath, OWNER_FILE), { bigint: true });
    if (!stat.isFile()) return null;
    return {
      owner,
      device: stat.dev,
      inode: stat.ino,
    };
  } catch {
    return null;
  }
}

function sameOwnerObservation(
  left: WorkspaceResourceLockOwnerObservation,
  right: WorkspaceResourceLockOwnerObservation
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.owner.schemaVersion === right.owner.schemaVersion &&
    left.owner.ownerId === right.owner.ownerId &&
    left.owner.pid === right.owner.pid &&
    left.owner.hostname === right.owner.hostname;
}

async function readRecoveryClaim(
  lockPath: string
): Promise<WorkspaceResourceLockRecoveryClaim | null> {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(lockPath, RECOVERY_CLAIM_FILE), 'utf8')
    ) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const claim = value as Record<string, unknown>;
    const targetOwner = claim.targetOwner;
    if (!targetOwner || typeof targetOwner !== 'object' || Array.isArray(targetOwner)) return null;
    const target = targetOwner as Record<string, unknown>;
    return claim.schemaVersion === 1 &&
      typeof claim.claimId === 'string' && claim.claimId.length > 0 &&
      Number.isSafeInteger(claim.claimantPid) && Number(claim.claimantPid) > 0 &&
      typeof claim.claimantHostname === 'string' && claim.claimantHostname.length > 0 &&
      typeof claim.targetDevice === 'string' && /^\d+$/.test(claim.targetDevice) &&
      typeof claim.targetInode === 'string' && /^\d+$/.test(claim.targetInode) &&
      target.schemaVersion === 2 &&
      typeof target.ownerId === 'string' && target.ownerId.length > 0 &&
      Number.isSafeInteger(target.pid) && Number(target.pid) > 0 &&
      typeof target.hostname === 'string' && target.hostname.length > 0
      ? {
          schemaVersion: 1,
          claimId: claim.claimId,
          claimantPid: Number(claim.claimantPid),
          claimantHostname: claim.claimantHostname,
          targetOwner: {
            schemaVersion: 2,
            ownerId: target.ownerId,
            pid: Number(target.pid),
            hostname: target.hostname,
          },
          targetDevice: claim.targetDevice,
          targetInode: claim.targetInode,
        }
      : null;
  } catch {
    return null;
  }
}

async function removeRecoveryClaimIfOwned(lockPath: string, claimId: string): Promise<void> {
  const claim = await readRecoveryClaim(lockPath);
  if (claim?.claimId !== claimId) return;
  try {
    await fs.unlink(path.join(lockPath, RECOVERY_CLAIM_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function quarantineDeadLocalOwner(
  lockPath: string,
  workspaceRoot: string,
  hostname: string,
  testHooks: MoAgentWorkspaceResourceLockOptions['recoveryTestHooks'],
): Promise<boolean> {
  const observed = await observeOwner(lockPath);
  if (
    !observed ||
    observed.owner.hostname !== hostname ||
    localProcessIsAlive(observed.owner.pid)
  ) return false;
  await testHooks?.afterDeadOwnerObserved?.();

  const claimId = randomUUID();
  const claim: WorkspaceResourceLockRecoveryClaim = {
    schemaVersion: 1,
    claimId,
    claimantPid: process.pid,
    claimantHostname: hostname,
    targetOwner: observed.owner,
    targetDevice: observed.device.toString(),
    targetInode: observed.inode.toString(),
  };
  try {
    await fs.writeFile(
      path.join(lockPath, RECOVERY_CLAIM_FILE),
      `${JSON.stringify(claim)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'EEXIST' ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) return false;
    throw error;
  }

  let quarantined = false;
  const quarantinePath = `${lockPath}.dead-${randomUUID()}`;
  try {
    // The fixed, exclusive claim lives inside the observed lock directory. It
    // prevents another compliant reconciler from moving that directory while
    // we validate it. If the path was replaced before the claim was created,
    // this re-read observes the replacement and we leave it untouched.
    const claimedOwner = await observeOwner(lockPath);
    if (
      !claimedOwner ||
      !sameOwnerObservation(observed, claimedOwner) ||
      claimedOwner.owner.hostname !== hostname ||
      localProcessIsAlive(claimedOwner.owner.pid)
    ) return false;

    await fs.rename(lockPath, quarantinePath);
    quarantined = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    if (!quarantined) {
      await removeRecoveryClaimIfOwned(lockPath, claimId);
    }
  }

  await syncDirectory(workspaceRoot);

  // Validate through the quarantined path before deleting anything. A failed
  // check is kept for manual reconciliation; importantly, cleanup never falls
  // back to the original path, which may now contain a new live owner.
  const quarantinedOwner = await observeOwner(quarantinePath);
  const quarantinedClaim = await readRecoveryClaim(quarantinePath);
  if (
    !quarantinedOwner ||
    !sameOwnerObservation(observed, quarantinedOwner) ||
    quarantinedClaim?.claimId !== claimId ||
    quarantinedClaim.targetOwner.ownerId !== observed.owner.ownerId ||
    quarantinedClaim.targetOwner.pid !== observed.owner.pid ||
    quarantinedClaim.targetOwner.hostname !== observed.owner.hostname ||
    quarantinedClaim.targetDevice !== observed.device.toString() ||
    quarantinedClaim.targetInode !== observed.inode.toString()
  ) {
    throw new MoAgentWorkspaceResourceLockError(
      'WORKSPACE_RESOURCE_LOCK_LOST',
      'Workspace stale-lock quarantine identity changed; manual reconciliation is required.'
    );
  }
  await fs.rm(quarantinePath, { recursive: true, force: true });
  await syncDirectory(workspaceRoot);
  return true;
}

/**
 * Serializes physical workspace mutation and DB lease takeover on the shared
 * filesystem itself. Ordinary callers never break locks. Startup recovery may
 * explicitly quarantine a schema-v2 same-host owner whose PID is provably
 * dead; remote, live, corrupt, or otherwise ambiguous locks remain fail-closed.
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
      if (
        options.recoverDeadLocalOwner === true &&
        await quarantineDeadLocalOwner(
          lockPath,
          canonicalRoot,
          hostname,
          options.recoveryTestHooks
        )
      ) {
        continue;
      }
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
