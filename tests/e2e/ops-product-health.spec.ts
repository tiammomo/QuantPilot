import { expect, test } from 'playwright/test';
import type { ProductHealthDashboard } from '../../src/lib/ops/product-health';

// Synthetic API evidence tests rendering/refresh, not live Mission generation.
const fixture: ProductHealthDashboard = {
  available: true,
  generatedAt: '2026-09-05T12:00:00.000Z',
  windowDays: 7,
  sampled: true,
  error: null,
  summary: {
    requests: 10_000,
    activeProjects: 200,
    completedRequests: 6000,
    failedRequests: 1000,
    cancelledRequests: 1000,
    activeRequests: 2000,
    acceptedDeliveries: 5999,
    completedMissions: 6000,
    unverifiedCompletedMissions: 1,
    terminalMissions: 8000,
    reports: 35,
    uniqueResearchers: 100,
    repeatResearchers: 60,
    requestCompletionRate: 75,
    missionAcceptanceRate: 75,
    evidenceCompletenessRate: 100,
    repeatResearcherRate: 60,
    medianDeliveryMs: 90_000,
    p90DeliveryMs: 300_000,
    p95DeliveryMs: 600_000,
    deliveryTimingSamples: 5998,
    invalidDeliveryTimings: 1,
  },
};

test.beforeEach(async ({ page, colorScheme }) => {
  await page.addInitScript((theme) => {
    localStorage.setItem('quantpilot-color-mode', theme ?? 'light');
  }, colorScheme);
});

test('disabled database displays a degradation notice without zero outcome cards', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/ops-platform');
  const panel = page.getByRole('region', { name: '研究闭环指标' });
  await expect(panel.getByRole('status')).toContainText('数据库已按降级配置停用');
  await expect(panel.locator('article')).toHaveCount(0);
  await panel.screenshot({ path: testInfo.outputPath('degraded.png') });
  expect(errors).toEqual([]);
});

test('refresh renders outcome evidence and preserves it on a subsequent API error', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/ops-platform');
  const panel = page.getByRole('region', { name: '研究闭环指标' });
  await expect(panel.getByRole('status')).toBeVisible();

  await page.route('**/api/ops/platform', async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, data: { ...payload.data, productHealth: fixture } } });
  });
  await page.getByRole('button', { name: '刷新运行状态' }).click();
  await expect(panel.locator('article')).toHaveCount(6);
  await expect(panel).toContainText('P90 5 分钟');
  await expect(panel).toContainText('P95 10 分钟');
  await expect(panel).toContainText('不能代表整个窗口');
  await expect(panel).toContainText('不代表第 7 日留存');
  await expect(panel.getByRole('status')).toContainText('1 个已完成 Mission');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath('outcomes-fixture.png') });

  await page.unroute('**/api/ops/platform');
  await page.route('**/api/ops/platform', (route) => route.fulfill({
    status: 503,
    json: { success: false, error: '测试：指标服务暂不可用' },
  }));
  await page.getByRole('button', { name: '刷新运行状态' }).click();
  await expect(page.getByText('测试：指标服务暂不可用', { exact: true })).toBeVisible();
  await expect(panel.locator('article')).toHaveCount(6);
  await expect(page.getByRole('button', { name: '刷新运行状态' })).toBeEnabled();
  expect(errors).toEqual([]);
});
