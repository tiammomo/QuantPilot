import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';

const DEFAULT_WINDOW_DAYS = 7;
const MAX_REQUEST_SAMPLE = 10_000;

const requestSelect = {
  projectId: true,
  actorUserId: true,
  status: true,
  createdAt: true,
  completedAt: true,
  agentMission: {
    select: {
      id: true,
      status: true,
      candidateVersion: true,
      acceptedReceiptId: true,
      completedAt: true,
      acceptedReceipt: {
        select: {
          id: true,
          missionId: true,
          candidateVersion: true,
          receiptType: true,
          verdict: true,
        },
      },
    },
  },
} satisfies Prisma.UserRequestSelect;

export type ProductHealthRequestSnapshot = Prisma.UserRequestGetPayload<{ select: typeof requestSelect }>;

interface ProductHealthClient {
  userRequest: {
    findMany(args: {
      where: Prisma.UserRequestWhereInput;
      orderBy: Prisma.UserRequestOrderByWithRelationInput[];
      take: number;
      select: typeof requestSelect;
    }): Promise<ProductHealthRequestSnapshot[]>;
  };
  researchReport: {
    count(args: object): Promise<number>;
  };
}

export interface ProductHealthDashboard {
  available: boolean;
  generatedAt: string;
  windowDays: number;
  sampled: boolean;
  summary: {
    requests: number;
    activeProjects: number;
    completedRequests: number;
    failedRequests: number;
    cancelledRequests: number;
    activeRequests: number;
    acceptedDeliveries: number;
    completedMissions: number;
    unverifiedCompletedMissions: number;
    terminalMissions: number;
    reports: number;
    uniqueResearchers: number;
    repeatResearchers: number;
    requestCompletionRate: number | null;
    missionAcceptanceRate: number | null;
    evidenceCompletenessRate: number | null;
    repeatResearcherRate: number | null;
    medianDeliveryMs: number | null;
    p90DeliveryMs: number | null;
    p95DeliveryMs: number | null;
    deliveryTimingSamples: number;
    invalidDeliveryTimings: number;
  };
  error: string | null;
}

function percentage(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

// Linear interpolation, including the ordinary midpoint median for even samples.
function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

function hasAcceptedEvidence(mission: ProductHealthRequestSnapshot['agentMission']): boolean {
  const receipt = mission?.acceptedReceipt;
  return Boolean(mission && receipt
    && mission.status === 'completed'
    && receipt.id === mission.acceptedReceiptId
    && receipt.missionId === mission.id
    && receipt.candidateVersion === mission.candidateVersion
    && receipt.receiptType === 'acceptance'
    && receipt.verdict === 'accepted');
}

export function summarizeProductHealth(params: {
  requests: ProductHealthRequestSnapshot[];
  reports: number;
  generatedAt: Date;
  windowDays?: number;
  sampled?: boolean;
}): ProductHealthDashboard {
  const terminalRequestStatuses = new Set(['completed', 'failed', 'cancelled']);
  const terminalMissionStatuses = new Set(['completed', 'failed', 'cancelled']);
  const completedRequests = params.requests.filter((request) => request.status === 'completed').length;
  const failedRequests = params.requests.filter((request) => request.status === 'failed').length;
  const cancelledRequests = params.requests.filter((request) => request.status === 'cancelled').length;
  const terminalRequests = params.requests.filter((request) => terminalRequestStatuses.has(request.status)).length;
  const activeRequests = params.requests.length - terminalRequests;
  const missions = params.requests.flatMap((request) => request.agentMission ? [request.agentMission] : []);
  const terminalMissions = missions.filter((mission) => terminalMissionStatuses.has(mission.status));
  const completedMissions = missions.filter((mission) => mission.status === 'completed').length;
  const acceptedRequests = params.requests.filter((request) => hasAcceptedEvidence(request.agentMission));
  const acceptedDeliveries = acceptedRequests.length;
  const deliveryDurations = acceptedRequests.flatMap((request) => {
    const completedAt = request.agentMission?.completedAt;
    if (!completedAt) return [];
    const duration = completedAt.getTime() - request.createdAt.getTime();
    if (!Number.isFinite(duration) || duration < 0 || completedAt > params.generatedAt) return [];
    return [duration];
  });
  const researcherRequestCounts = new Map<string, number>();
  for (const request of params.requests) {
    if (!request.actorUserId) continue;
    researcherRequestCounts.set(
      request.actorUserId,
      (researcherRequestCounts.get(request.actorUserId) ?? 0) + 1,
    );
  }
  const repeatResearchers = [...researcherRequestCounts.values()].filter((count) => count >= 2).length;

  return {
    available: true,
    generatedAt: params.generatedAt.toISOString(),
    windowDays: params.windowDays ?? DEFAULT_WINDOW_DAYS,
    sampled: params.sampled ?? false,
    summary: {
      requests: params.requests.length,
      activeProjects: new Set(params.requests.map((request) => request.projectId)).size,
      completedRequests,
      failedRequests,
      cancelledRequests,
      activeRequests,
      acceptedDeliveries,
      completedMissions,
      unverifiedCompletedMissions: completedMissions - acceptedDeliveries,
      terminalMissions: terminalMissions.length,
      reports: params.reports,
      uniqueResearchers: researcherRequestCounts.size,
      repeatResearchers,
      requestCompletionRate: percentage(completedRequests, terminalRequests),
      missionAcceptanceRate: percentage(acceptedDeliveries, terminalMissions.length),
      evidenceCompletenessRate: percentage(acceptedDeliveries, completedMissions),
      repeatResearcherRate: percentage(repeatResearchers, researcherRequestCounts.size),
      medianDeliveryMs: percentile(deliveryDurations, 0.5),
      p90DeliveryMs: percentile(deliveryDurations, 0.9),
      p95DeliveryMs: percentile(deliveryDurations, 0.95),
      deliveryTimingSamples: deliveryDurations.length,
      invalidDeliveryTimings: acceptedDeliveries - deliveryDurations.length,
    },
    error: null,
  };
}

export async function getProductHealthDashboard(params: {
  client?: ProductHealthClient;
  enabled?: boolean;
  now?: Date;
  windowDays?: number;
} = {}): Promise<ProductHealthDashboard> {
  const now = params.now ?? new Date();
  const windowDays = params.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (params.enabled === false) {
    return unavailableProductHealthDashboard({
      now,
      windowDays,
      error: '数据库已按降级配置停用，产品闭环指标未采集。',
    });
  }

  const client: ProductHealthClient = params.client ?? {
    userRequest: { findMany: (args) => prisma.userRequest.findMany(args) },
    researchReport: { count: (args) => prisma.researchReport.count(args) },
  };
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1_000);

  try {
    const [requests, reports] = await Promise.all([
      client.userRequest.findMany({
        where: { createdAt: { gte: since, lte: now } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_REQUEST_SAMPLE + 1,
        select: requestSelect,
      }),
      client.researchReport.count({ where: { reportDate: { gte: since, lte: now } } }),
    ]);
    const sampled = requests.length > MAX_REQUEST_SAMPLE;
    return summarizeProductHealth({
      requests: requests.slice(0, MAX_REQUEST_SAMPLE),
      reports,
      generatedAt: now,
      windowDays,
      sampled,
    });
  } catch {
    return unavailableProductHealthDashboard({
      now,
      windowDays,
      error: '产品闭环指标暂不可用，请检查数据库连接。',
    });
  }
}

function unavailableProductHealthDashboard(params: {
  now: Date;
  windowDays: number;
  error: string;
}): ProductHealthDashboard {
  return {
    available: false,
    generatedAt: params.now.toISOString(),
    windowDays: params.windowDays,
    sampled: false,
    summary: {
      requests: 0,
      activeProjects: 0,
      completedRequests: 0,
      failedRequests: 0,
      cancelledRequests: 0,
      activeRequests: 0,
      acceptedDeliveries: 0,
      completedMissions: 0,
      unverifiedCompletedMissions: 0,
      terminalMissions: 0,
      reports: 0,
      uniqueResearchers: 0,
      repeatResearchers: 0,
      requestCompletionRate: null,
      missionAcceptanceRate: null,
      evidenceCompletenessRate: null,
      repeatResearcherRate: null,
      medianDeliveryMs: null,
      p90DeliveryMs: null,
      p95DeliveryMs: null,
      deliveryTimingSamples: 0,
      invalidDeliveryTimings: 0,
    },
    error: params.error,
  };
}
