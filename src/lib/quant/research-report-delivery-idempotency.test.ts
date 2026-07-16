import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deliveryCreate: vi.fn(),
  deliveryUpdate: vi.fn(),
  deliveryFindUnique: vi.fn(),
  deliverNotification: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    notificationDelivery: {
      create: mocks.deliveryCreate,
      update: mocks.deliveryUpdate,
      findUnique: mocks.deliveryFindUnique,
    },
  },
}));

vi.mock('./notification-adapters', () => ({
  deliverResearchReportNotification: mocks.deliverNotification,
}));

import { createNotificationDeliveries } from './research-reports';

const report = {
  id: 'report-1',
  title: '日报',
  summary: '摘要',
  score: 80,
  recommendation: '观察',
  riskLevel: 'medium',
  contentMarkdown: '# 日报',
};

const channel = {
  id: 'channel-1',
  name: '企业微信',
  channelType: 'wxwork',
  target: 'research',
  config: {},
  isDryRun: false,
};

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    idempotencyKey: 'delivery-key',
    runId: null,
    reportId: report.id,
    channelId: channel.id,
    status: 'sending',
    channelType: channel.channelType,
    title: report.title,
    payload: {},
    error: null,
    deliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('research notification delivery idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deliveryCreate.mockResolvedValue(delivery());
    mocks.deliveryUpdate.mockResolvedValue(delivery({ status: 'delivered', deliveredAt: new Date() }));
    mocks.deliveryFindUnique.mockResolvedValue(delivery({ status: 'delivered', deliveredAt: new Date() }));
    mocks.deliverNotification.mockResolvedValue({
      status: 'delivered',
      channelType: 'wxwork',
      title: report.title,
      payload: { ok: true },
      error: null,
      deliveredAt: new Date(),
    });
  });

  it('reserves before webhook execution and suppresses a duplicate operation key', async () => {
    const first = await createNotificationDeliveries({
      report,
      channels: [channel],
      dryRun: false,
      idempotencyKey: 'research-delivery:member-1:send-1',
    });
    const firstKey = mocks.deliveryCreate.mock.calls[0][0].data.idempotencyKey;
    expect(firstKey).toMatch(/^research-notification:[a-f0-9]{64}$/);
    expect(mocks.deliveryCreate.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deliverNotification.mock.invocationCallOrder[0]);

    mocks.deliveryCreate.mockRejectedValueOnce({ code: 'P2002' });
    const replay = await createNotificationDeliveries({
      report,
      channels: [channel],
      dryRun: false,
      idempotencyKey: 'research-delivery:member-1:send-1',
    });

    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(1);
    expect(mocks.deliveryFindUnique).toHaveBeenCalledWith({ where: { idempotencyKey: firstKey } });
    expect(mocks.deliverNotification).toHaveBeenCalledTimes(1);
  });
});
