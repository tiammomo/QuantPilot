import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  claimMoAgentGenerationJob,
  enqueueMoAgentGenerationJob,
  heartbeatMoAgentGenerationJob,
  type MoAgentGenerationDispatchClaim,
  type MoAgentGenerationDispatchFence,
} from "@/lib/services/moagent-generation-dispatch-store";

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface MoAgentGenerationDispatchSessionOptions {
  leaseOwner?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatEnabled?: boolean;
}

function configuredPositiveInteger(
  name: string,
  explicit: number | undefined,
  fallback: number,
): number {
  const raw =
    explicit ?? (process.env[name] ? Number(process.env[name]) : fallback);
  if (!Number.isSafeInteger(raw) || raw <= 0 || raw > MAX_INTERVAL_MS) {
    throw new Error(
      `${name} must be a positive safe integer no greater than one day.`,
    );
  }
  return raw;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const dispatchContext =
  new AsyncLocalStorage<MoAgentGenerationDispatchSession>();

/**
 * A process worker's handle to one PostgreSQL generation job. Nested terminal
 * writers read this session through AsyncLocalStorage, so cancellation or a
 * takeover fences late validation callbacks without threading tokens through
 * the entire orchestration stack.
 */
export class MoAgentGenerationDispatchSession {
  private readonly leaseTtlMs: number;
  private timer: ReturnType<typeof globalThis.setInterval> | undefined;
  private heartbeatQueue: Promise<void> = Promise.resolve();
  private fatalError: Error | null = null;
  private settled = false;
  private terminal = false;

  private constructor(
    readonly claim: MoAgentGenerationDispatchClaim,
    options: {
      leaseTtlMs: number;
      heartbeatIntervalMs: number;
      heartbeatEnabled: boolean;
    },
  ) {
    this.leaseTtlMs = options.leaseTtlMs;
    if (options.heartbeatEnabled) {
      this.timer = globalThis.setInterval(() => {
        if (this.settled || this.fatalError) return;
        void this.serializeHeartbeat(async () => {
          await heartbeatMoAgentGenerationJob({
            fence: this.fence,
            leaseTtlMs: this.leaseTtlMs,
          });
        }).catch(() => undefined);
      }, options.heartbeatIntervalMs);
      this.timer.unref?.();
    }
  }

  static async enqueueAndClaim(
    input: {
      projectId: string;
      requestId: string;
      instruction: string;
      cliPreference?: string | null;
      selectedModel?: string | null;
      executionEnvelope?: unknown;
      maxAttempts?: number;
    },
    options: MoAgentGenerationDispatchSessionOptions = {},
  ): Promise<MoAgentGenerationDispatchSession> {
    const leaseTtlMs = configuredPositiveInteger(
      "MOAGENT_DISPATCH_LEASE_TTL_MS",
      options.leaseTtlMs,
      DEFAULT_LEASE_TTL_MS,
    );
    const heartbeatIntervalMs = configuredPositiveInteger(
      "MOAGENT_DISPATCH_HEARTBEAT_INTERVAL_MS",
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    const heartbeatEnabled = options.heartbeatEnabled !== false;
    if (heartbeatEnabled && heartbeatIntervalMs >= leaseTtlMs) {
      throw new Error(
        "MOAGENT_DISPATCH_HEARTBEAT_INTERVAL_MS must be smaller than the lease TTL.",
      );
    }
    await enqueueMoAgentGenerationJob(input);
    const claim = await claimMoAgentGenerationJob({
      projectId: input.projectId,
      requestId: input.requestId,
      leaseOwner:
        options.leaseOwner ??
        `generation-dispatcher:${process.pid}:${randomUUID()}`,
      leaseTtlMs,
    });
    return new MoAgentGenerationDispatchSession(claim, {
      leaseTtlMs,
      heartbeatIntervalMs,
      heartbeatEnabled,
    });
  }

  get fence(): MoAgentGenerationDispatchFence {
    return {
      jobId: this.claim.jobId,
      projectId: this.claim.projectId,
      requestId: this.claim.requestId,
      leaseOwner: this.claim.leaseOwner,
      fencingToken: this.claim.fencingToken,
    };
  }

  get failure(): Error | null {
    return this.fatalError;
  }

  assertHealthy(): void {
    if (this.settled)
      throw new Error("Generation dispatch session is already settled.");
    if (this.fatalError) throw this.fatalError;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.assertHealthy();
    return dispatchContext.run(this, task);
  }

  settle(): void {
    if (this.settled) return;
    this.stopHeartbeat();
    this.settled = true;
  }

  markTerminal(): void {
    if (this.settled || this.terminal) return;
    this.terminal = true;
    this.stopHeartbeat();
  }

  dispose(): void {
    this.settle();
  }

  private stopHeartbeat(): void {
    if (!this.timer) return;
    globalThis.clearInterval(this.timer);
    this.timer = undefined;
  }

  private serializeHeartbeat<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.heartbeatQueue.then(async () => {
      if (this.fatalError) throw this.fatalError;
      return operation();
    });
    this.heartbeatQueue = task.then(
      () => undefined,
      (error: unknown) => {
        if (!this.fatalError) {
          this.fatalError = asError(error);
          this.stopHeartbeat();
        }
      },
    );
    return task;
  }
}

export function currentMoAgentGenerationDispatchFence():
  | MoAgentGenerationDispatchFence
  | undefined {
  return dispatchContext.getStore()?.fence;
}

export function currentMoAgentGenerationDispatchSession():
  | MoAgentGenerationDispatchSession
  | undefined {
  return dispatchContext.getStore();
}

export function assertCurrentMoAgentGenerationDispatchHealthy(): void {
  dispatchContext.getStore()?.assertHealthy();
}
