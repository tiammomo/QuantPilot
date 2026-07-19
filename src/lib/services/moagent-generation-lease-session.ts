import { randomUUID } from 'node:crypto';
import {
  claimMoAgentGenerationLease,
  heartbeatMoAgentGenerationLease,
  releaseMoAgentGenerationLease,
  type MoAgentGenerationLeaseClaim,
  type MoAgentGenerationLeaseFence,
  type MoAgentGenerationStage,
} from '@/lib/services/moagent-generation-lease-store';

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface MoAgentGenerationLeaseSessionOptions {
  leaseOwner?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatEnabled?: boolean;
}

function configuredPositiveInteger(
  name: string,
  explicit: number | undefined,
  fallback: number
): number {
  const raw = explicit ?? (process.env[name] ? Number(process.env[name]) : fallback);
  if (!Number.isSafeInteger(raw) || raw <= 0 || raw > MAX_INTERVAL_MS) {
    throw new Error(`${name} must be a positive safe integer no greater than one day.`);
  }
  return raw;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Process lifecycle for the database-backed outer orchestration lease. Its
 * independent heartbeat keeps long model/build stages owned without coupling
 * their fine-grained AgentRun or Mission fences to the HTTP request lifetime.
 */
export class MoAgentGenerationLeaseSession {
  private readonly leaseTtlMs: number;
  private timer: ReturnType<typeof globalThis.setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private fatalError: Error | null = null;
  private settled = false;

  private constructor(
    readonly claim: MoAgentGenerationLeaseClaim,
    options: {
      leaseTtlMs: number;
      heartbeatIntervalMs: number;
      heartbeatEnabled: boolean;
    }
  ) {
    this.leaseTtlMs = options.leaseTtlMs;
    if (options.heartbeatEnabled) {
      this.timer = globalThis.setInterval(() => {
        if (this.settled || this.fatalError) return;
        void this.serialize(async () => {
          await heartbeatMoAgentGenerationLease({
            fence: this.fence,
            leaseTtlMs: this.leaseTtlMs,
          });
        }, true).catch(() => undefined);
      }, options.heartbeatIntervalMs);
      this.timer.unref?.();
    }
  }

  static async claimProject(
    input: {
      projectId: string;
      operationId?: string;
      requestId?: string | null;
      stage: MoAgentGenerationStage;
    },
    options: MoAgentGenerationLeaseSessionOptions = {}
  ): Promise<MoAgentGenerationLeaseSession> {
    const leaseTtlMs = configuredPositiveInteger(
      'MOAGENT_GENERATION_LEASE_TTL_MS',
      options.leaseTtlMs,
      DEFAULT_LEASE_TTL_MS
    );
    const heartbeatIntervalMs = configuredPositiveInteger(
      'MOAGENT_GENERATION_HEARTBEAT_INTERVAL_MS',
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS
    );
    const heartbeatEnabled = options.heartbeatEnabled !== false;
    if (heartbeatEnabled && heartbeatIntervalMs >= leaseTtlMs) {
      throw new Error(
        'MOAGENT_GENERATION_HEARTBEAT_INTERVAL_MS must be smaller than the lease TTL.'
      );
    }
    const operationId = input.operationId ?? input.requestId ?? `operation:${randomUUID()}`;
    const leaseOwner =
      options.leaseOwner ?? `generation-orchestrator:${process.pid}:${randomUUID()}`;
    const claim = await claimMoAgentGenerationLease({
      projectId: input.projectId,
      operationId,
      requestId: input.requestId,
      stage: input.stage,
      leaseOwner,
      leaseTtlMs,
    });
    return new MoAgentGenerationLeaseSession(claim, {
      leaseTtlMs,
      heartbeatIntervalMs,
      heartbeatEnabled,
    });
  }

  get fence(): MoAgentGenerationLeaseFence {
    return {
      projectId: this.claim.projectId,
      operationId: this.claim.operationId,
      leaseOwner: this.claim.leaseOwner,
      fencingToken: this.claim.fencingToken,
    };
  }

  get failure(): Error | null {
    return this.fatalError;
  }

  assertHealthy(): void {
    if (this.settled) throw new Error('Generation lease session is already settled.');
    if (this.fatalError) throw this.fatalError;
  }

  async release(): Promise<void> {
    this.assertHealthy();
    this.stopHeartbeat();
    await this.serialize(async () => {
      this.assertHealthy();
      await releaseMoAgentGenerationLease({ fence: this.fence });
    }, true);
    this.settled = true;
  }

  async dispose(): Promise<void> {
    if (this.settled) return;
    this.stopHeartbeat();
    try {
      await this.serialize(() => releaseMoAgentGenerationLease({ fence: this.fence }), false);
    } finally {
      this.settled = true;
    }
  }

  private stopHeartbeat(): void {
    if (!this.timer) return;
    globalThis.clearInterval(this.timer);
    this.timer = undefined;
  }

  private serialize<T>(operation: () => Promise<T>, captureFailure: boolean): Promise<T> {
    const task = this.queue.then(async () => {
      if (captureFailure && this.fatalError) throw this.fatalError;
      return operation();
    });
    this.queue = task.then(
      () => undefined,
      (error: unknown) => {
        if (captureFailure && !this.fatalError) {
          this.fatalError = asError(error);
          this.stopHeartbeat();
        }
      }
    );
    return task;
  }
}

export async function withMoAgentGenerationLease<T>(input: {
  projectId: string;
  operationId?: string;
  requestId?: string | null;
  stage: MoAgentGenerationStage;
  options?: MoAgentGenerationLeaseSessionOptions;
  task: (session: MoAgentGenerationLeaseSession) => Promise<T>;
}): Promise<T> {
  const session = await MoAgentGenerationLeaseSession.claimProject(input, input.options);
  try {
    const result = await input.task(session);
    await session.release();
    return result;
  } catch (error) {
    await session.dispose().catch(() => undefined);
    throw error;
  }
}
