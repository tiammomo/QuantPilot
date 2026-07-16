import type { Prisma } from '@prisma/client';

export const QUOTA_ENFORCEMENTS = ['observe', 'warn', 'hard'] as const;
export type QuotaEnforcement = (typeof QUOTA_ENFORCEMENTS)[number];

export const QUOTA_WINDOW_TYPES = [
  'minute',
  'hour',
  'day',
  'month',
  'fixed',
  'lifetime',
] as const;
export type QuotaWindowType = (typeof QUOTA_WINDOW_TYPES)[number];

export type QuotaPolicySource =
  | 'administrator'
  | 'user-override'
  | 'profile'
  | 'builtin-default'
  | 'unconfigured';

export interface ResolvedQuotaPolicy {
  actorUserId: string;
  metric: string;
  source: QuotaPolicySource;
  unlimited: boolean;
  limit: bigint | null;
  enforcement: QuotaEnforcement;
  windowType: QuotaWindowType;
  windowSeconds: number | null;
  reservationTtlSeconds: number;
  enforcementExempt: boolean;
}

export interface QuotaWindow {
  start: Date;
  end: Date;
}

export interface QuotaCounterSnapshot {
  used: bigint;
  reserved: bigint;
  requested: bigint;
  limit: bigint | null;
  remaining: bigint | null;
  exceeded: boolean;
}

export interface QuotaReservationView extends QuotaCounterSnapshot {
  id: string;
  idempotencyKey: string;
  actorUserId: string;
  projectId: string | null;
  metric: string;
  status: 'active' | 'settled' | 'released' | 'expired';
  committedQuantity: bigint;
  enforcement: QuotaEnforcement;
  enforcementExempt: boolean;
  windowStart: Date;
  windowEnd: Date;
  expiresAt: Date;
  idempotent: boolean;
}

export interface QuotaReserveResult {
  allowed: boolean;
  mode: 'metered' | 'unlimited';
  policy: ResolvedQuotaPolicy;
  counter: QuotaCounterSnapshot;
  window: QuotaWindow;
  reservation: QuotaReservationView | null;
}

export interface ReserveQuotaInput {
  actorUserId: string;
  metric: string;
  quantity: bigint | number | string;
  idempotencyKey: string;
  projectId?: string | null;
  now?: Date;
  reservationTtlSeconds?: number;
}

export interface SettleQuotaInput {
  reservationId?: string;
  reservationIdempotencyKey?: string;
  actualQuantity: bigint | number | string;
  sourceType: string;
  sourceId?: string | null;
  usageEventIdempotencyKey?: string;
  occurredAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

export interface ReleaseQuotaInput {
  reservationId?: string;
  reservationIdempotencyKey?: string;
  now?: Date;
}

export interface RenewQuotaInput {
  reservationId?: string;
  reservationIdempotencyKey?: string;
  reservationTtlSeconds?: number;
  now?: Date;
}

export interface RecordUsageInput {
  actorUserId: string;
  metric: string;
  quantity: bigint | number | string;
  idempotencyKey: string;
  sourceType: string;
  sourceId?: string | null;
  projectId?: string | null;
  occurredAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

export interface UsageSettlementResult {
  eventId: string;
  reservationId: string | null;
  actorUserId: string;
  projectId: string | null;
  metric: string;
  quantity: bigint;
  enforcementExempt: boolean;
  sourceType: string;
  sourceId: string | null;
  occurredAt: Date;
  counter: Omit<QuotaCounterSnapshot, 'requested'>;
  idempotent: boolean;
}
