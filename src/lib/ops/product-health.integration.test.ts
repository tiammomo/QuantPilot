import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getProductHealthDashboard } from './product-health';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const scope = `product_health_pg_it_${randomUUID()}`;
// Keep this window separate from the runtime/approval suites' current-time data.
const now = new Date('2020-01-08T12:00:00Z');
const since = new Date('2020-01-01T12:00:00Z');

describe.skipIf(!databaseUrl)('product health (PostgreSQL integration)', () => {
  let client: PrismaClient;

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: databaseUrl! });
    await client.$connect();
    await client.project.create({ data: { id: scope, name: 'Product health integration' } });
    await client.authUser.create({ data: { id: scope, name: 'Researcher', email: `${scope}@test.invalid` } });
  });

  afterAll(async () => {
    try {
      await client.agentMission.deleteMany({ where: { projectId: scope } });
      await client.project.deleteMany({ where: { id: scope } });
      await client.authUser.deleteMany({ where: { id: scope } });
      await client.researchReportRun.deleteMany({ where: { id: scope } });
    } finally {
      await client.$disconnect();
    }
  });

  it('reads persisted evidence relations and applies the time window to requests and reports', async () => {
    const times = [since, new Date('2020-01-04T12:00:00Z'), now,
      new Date(since.getTime() - 1), new Date(now.getTime() + 1)];
    for (const [index, createdAt] of times.entries()) {
      const id = `${scope}:${index}`;
      await client.userRequest.create({ data: {
        id, projectId: scope, instruction: 'Fixture research',
        actorUserId: index < 2 ? scope : null,
        status: index === 2 ? 'pending' : 'completed', createdAt,
      } });
      if (index > 1) continue;
      await client.agentMission.create({ data: {
        id, projectId: scope, requestId: id, status: 'completed', activeSlot: null,
        candidateVersion: 2, spec: { fixture: true }, specHash: `sha256:${id}`,
        completedAt: new Date(createdAt.getTime() + 60_000),
        receipts: { create: {
          id, candidateVersion: index === 0 ? 2 : 1,
          receiptType: 'acceptance', verdict: 'accepted', subjectHash: `sha256:${id}`,
          receiptHash: `sha256:${id}`, payload: { fixture: true },
        } },
      } });
      await client.agentMission.update({ where: { id }, data: { acceptedReceiptId: id } });
    }
    await client.researchReportRun.create({ data: {
      id: scope, status: 'completed', runType: 'manual', startedAt: since, metadata: {},
      reports: { create: times.map((reportDate, index) => ({
        id: `${scope}:${index}`, title: 'Fixture report', summary: 'Fixture', reportDate,
        marketScope: {}, score: 0, recommendation: 'observe', riskLevel: 'unknown',
        contentMarkdown: 'Fixture', structured: {}, evidence: {},
      })) },
    } });

    const dashboard = await getProductHealthDashboard({ client, now });
    expect(dashboard.available).toBe(true);
    expect(dashboard.sampled).toBe(false);
    expect(dashboard.summary).toMatchObject({
      requests: 3, reports: 3, activeProjects: 1, activeRequests: 1,
      completedRequests: 2, completedMissions: 2, acceptedDeliveries: 1,
      unverifiedCompletedMissions: 1, evidenceCompletenessRate: 50,
      missionAcceptanceRate: 50, uniqueResearchers: 1, repeatResearchers: 1,
      medianDeliveryMs: 60_000, deliveryTimingSamples: 1,
    });
  });
});
