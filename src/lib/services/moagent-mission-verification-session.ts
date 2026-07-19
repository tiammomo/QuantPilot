import { randomUUID } from 'node:crypto';
import type {
  MoAgentMissionHandle,
  MoAgentMissionVerificationFence,
} from '@/lib/agent/mission';
import {
  abandonMoAgentMissionVerification,
  beginMoAgentMissionVerification,
  heartbeatMoAgentMissionVerification,
} from '@/lib/services/moagent-mission-store';

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface MoAgentMissionVerificationSessionOptions {
  leaseOwner?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatEnabled?: boolean;
}

interface MissionReference {
  missionId: string;
  projectId: string;
  requestId: string;
}

function configuredPositiveInteger(
  name: string,
  explicit: number | undefined,
  fallback: number,
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
 * Process-local lifecycle around a database-backed Mission verification lease.
 * Heartbeats and the final evidence commit share one queue, while every durable
 * mutation remains fenced by the monotonically increasing database token.
 */
export class MoAgentMissionVerificationSession {
  private readonly ref: MissionReference;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private timer: ReturnType<typeof globalThis.setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private fatalError: Error | null = null;
  private releasedMission: MoAgentMissionHandle | null = null;
  private settled = false;
  private disposed = false;

  private constructor(
    readonly mission: MoAgentMissionHandle,
    private readonly leaseOwner: string,
    private readonly fencingToken: number,
    private leaseExpiresAt: string,
    options: {
      leaseTtlMs: number;
      heartbeatIntervalMs: number;
      heartbeatEnabled: boolean;
    },
  ) {
    this.ref = {
      missionId: mission.id,
      projectId: mission.projectId,
      requestId: mission.requestId,
    };
    this.leaseTtlMs = options.leaseTtlMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    if (options.heartbeatEnabled) this.startHeartbeat();
  }

  static async claim(
    ref: MissionReference,
    options: MoAgentMissionVerificationSessionOptions = {},
  ): Promise<MoAgentMissionVerificationSession> {
    const leaseTtlMs = configuredPositiveInteger(
      'MOAGENT_MISSION_VERIFICATION_LEASE_TTL_MS',
      options.leaseTtlMs,
      DEFAULT_LEASE_TTL_MS,
    );
    const heartbeatIntervalMs = configuredPositiveInteger(
      'MOAGENT_MISSION_VERIFICATION_HEARTBEAT_INTERVAL_MS',
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    const heartbeatEnabled = options.heartbeatEnabled !== false;
    if (heartbeatEnabled && heartbeatIntervalMs >= leaseTtlMs) {
      throw new Error(
        'MOAGENT_MISSION_VERIFICATION_HEARTBEAT_INTERVAL_MS must be smaller than the lease TTL.',
      );
    }
    const leaseOwner = options.leaseOwner ??
      `mission-verifier:${process.pid}:${randomUUID()}`;
    const claim = await beginMoAgentMissionVerification({
      ...ref,
      leaseOwner,
      leaseTtlMs,
    });
    return new MoAgentMissionVerificationSession(
      claim.mission,
      claim.leaseOwner,
      claim.fencingToken,
      claim.leaseExpiresAt,
      { leaseTtlMs, heartbeatIntervalMs, heartbeatEnabled },
    );
  }

  get fence(): MoAgentMissionVerificationFence {
    return {
      leaseOwner: this.leaseOwner,
      fencingToken: this.fencingToken,
    };
  }

  get expiresAt(): string {
    return this.leaseExpiresAt;
  }

  get failure(): Error | null {
    return this.fatalError;
  }

  get release(): MoAgentMissionHandle | null {
    return this.releasedMission ? { ...this.releasedMission } : null;
  }

  assertHealthy(): void {
    if (this.disposed) throw new Error('Mission verification session is disposed.');
    if (this.settled) throw new Error('Mission verification session is already settled.');
    if (this.fatalError) throw this.fatalError;
  }

  async commit<T>(
    operation: (fence: MoAgentMissionVerificationFence) => Promise<T>,
  ): Promise<T> {
    this.assertHealthy();
    this.stopHeartbeat();
    const result = await this.serialize(async () => {
      this.assertHealthy();
      return operation(this.fence);
    }, true);
    this.settled = true;
    return result;
  }

  async dispose(): Promise<MoAgentMissionHandle | null> {
    if (this.disposed) return this.release;
    this.disposed = true;
    this.stopHeartbeat();
    if (this.settled) {
      await this.queue;
      return null;
    }
    try {
      this.releasedMission = await this.serialize(
        () => abandonMoAgentMissionVerification({ ...this.ref, ...this.fence }),
        false,
      );
      return this.release;
    } finally {
      this.settled = true;
    }
  }

  private startHeartbeat(): void {
    this.timer = globalThis.setInterval(() => {
      if (this.disposed || this.settled || this.fatalError) return;
      void this.serialize(async () => {
        const heartbeat = await heartbeatMoAgentMissionVerification({
          ...this.ref,
          ...this.fence,
          leaseTtlMs: this.leaseTtlMs,
        });
        this.leaseExpiresAt = heartbeat.leaseExpiresAt;
      }, true).catch(() => undefined);
    }, this.heartbeatIntervalMs);
    this.timer.unref?.();
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
      },
    );
    return task;
  }
}
