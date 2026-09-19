import { expect, test, type Page } from 'playwright/test';
import type { QuantGenerationTerminalSnapshot } from '../../src/lib/quant/generation-terminal';

async function openWorkspace(page: Page, accepted = true, activeCount = 0, turnMetrics?: unknown,
  initialSnapshot: Partial<QuantGenerationTerminalSnapshot> = {}) {
  let snapshot: QuantGenerationTerminalSnapshot = {
    requestId: 'request-1',
    status: 'ready',
    terminal: true,
    validationStatus: 'passed',
    validationRunId: 'request-1',
    validationMatchesCurrentRun: true,
    missionAcceptanceRequired: true,
    missionAcceptanceSatisfied: accepted,
    acceptedReceiptId: accepted ? 'receipt-1' : null,
    previewStatus: 'running',
    previewUrl: '/fixture-preview',
    previewPort: 4101,
    persistedPreviewUrl: '/fixture-preview',
    errorMessage: null,
    ...initialSnapshot,
  };
  let reads = 0;
  let starts = 0;
  let stops = 0;
  let deployments = 0;
  let activityReads = 0;
  let activityOffline = false;
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/fixture-preview**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>已验收研究结果</h1>' })
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown = {};
    if (path === '/api/projects/preview-fixture')
      json = { id: 'preview-fixture', name: '预览回归', status: 'active', preferredCli: 'pi' };
    else if (path.endsWith('/generation/status')) {
      reads += 1;
      json = { data: snapshot };
    } else if (path.endsWith('/preview/start')) {
      starts += 1;
      json = { data: { url: '/fixture-preview' } };
    } else if (path.endsWith('/preview/stop')) {
      stops += 1;
      json = { success: true };
    } else if (path.endsWith('/tree')) json = [{ path: 'a.ts', type: 'file' }];
    else if (path.endsWith('/file')) json = { content: 'export const value = 1;' };
    else if (path.endsWith('/services')) json = [{ provider: 'github' }, { provider: 'vercel', service_data: {} }];
    else if (path.endsWith('/deployment/current')) json = { has_deployment: false };
    else if (path.endsWith('/github/push')) json = { success: true };
    else if (path.endsWith('/vercel/deploy')) {
      deployments += 1;
      if (deployments === 1) {
        await route.fulfill({ status: 503, json: { error: 'fixture: temporary failure' } });
        return;
      }
      json = { ready: true, deployment_url: 'research.example/preview' };
    } else if (path.endsWith('/install-dependencies')) json = { success: true };
    else if (path.endsWith('/requests/active')) {
      activityReads += 1;
      if (activityOffline) {
        await route.abort('failed');
        return;
      }
      json = { hasActiveRequests: activeCount > 0, activeCount };
    } else if (path.endsWith('/agent/approvals')) json = { success: true, data: [] };
    else if (path.endsWith('/messages')) json = {
      messages: turnMetrics ? [{
        id: 'result-message',
        projectId: 'preview-fixture',
        role: 'assistant',
        messageType: 'chat',
        content: '研究已完成，结果可供复盘。',
        requestId: 'request-1',
        createdAt: '2026-09-06T00:00:00.000Z',
        cliSource: 'pi',
        metadata: { isMissionFinal: true, turnMetrics },
      }] : [],
      pagination: { hasMore: false },
      totalCount: turnMetrics ? 1 : 0,
    };
    else if (path.endsWith('/stream')) {
      await route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      return;
    } else if (path === '/api/settings/global') json = { default_cli: 'pi' };
    else {
      unexpected.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 404, json: { error: 'Unconfigured fixture' } });
      return;
    }
    await route.fulfill({ json });
  });
  await page.goto('/preview-fixture/chat');
  return {
    setSnapshot: (patch: Partial<QuantGenerationTerminalSnapshot>) => { snapshot = { ...snapshot, ...patch }; },
    get reads() {
      return reads;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get deployments() {
      return deployments;
    },
    unexpected,
    errors,
    get activityReads() {
      return activityReads;
    },
    disconnectActivity: () => {
      activityOffline = true;
    },
    accept: () => {
      snapshot = { ...snapshot, missionAcceptanceSatisfied: true, acceptedReceiptId: 'receipt-1' };
    },
  };
}

const preview = (page: Page) =>
  page.frameLocator('iframe[title="研究看板预览"]').getByRole('heading', { name: '已验收研究结果' });

test('restores planning failure after reload without requesting clarification or starting a preview', async ({ page, isMobile }) => {
  const message = '当前模型尚未配置，无法开始研究。请配置可用模型后重新发起研究。';
  const fixture = await openWorkspace(page, false, 0, undefined, {
    status: 'failed', validationStatus: 'pending', validationRunId: null,
    validationMatchesCurrentRun: false, previewStatus: 'stopped',
    previewUrl: null, previewPort: null, persistedPreviewUrl: null, errorMessage: message,
  });
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    if (isMobile) await page.getByRole('navigation', { name: '移动端工作区视图' })
      .getByRole('button', { name: '看板', exact: true }).click();
    await expect(page.getByRole('heading', { name: '研究未完成', exact: true })).toBeVisible();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByText('看板验证未通过', { exact: true })).toHaveCount(0);
    await expect(page.getByText('补充关键信息', { exact: true })).toHaveCount(0);
    await expect(page.locator('iframe[title="研究看板预览"]')).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
  }
  expect(fixture.starts).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('restores actual data progress after reload and follows server stage changes', async ({ page, isMobile }, testInfo) => {
  const fixture = await openWorkspace(page, false, 1, undefined, {
    status: 'running', terminal: false, validationStatus: 'pending', previewUrl: null,
    activeStep: 'data_prefetch', stepSummary: '数据预取已处理 2/4 个标的，2 个取得数据；正在整理证据。',
  });
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    if (isMobile) await page.getByRole('navigation', { name: '移动端工作区视图' })
      .getByRole('button', { name: '看板', exact: true }).click();
    const waiting = page.getByTestId('dashboard-generation-waiting-generating');
    await expect(waiting).toContainText('数据预取已处理 2/4 个标的');
    await expect(waiting.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '当前阶段：准备数据');
  }
  fixture.setSnapshot({ activeStep: 'agent_execution', stepSummary: '数据已准备，正在生成看板。' });
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '当前阶段：生成看板');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('generation-progress.png') });
  expect(fixture.starts).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('waits for Mission acceptance and preserves the selected file view on later ready polls', async ({
  page,
  isMobile,
}) => {
  const fixture = await openWorkspace(page, false);
  await expect.poll(() => fixture.reads).toBeGreaterThan(0);
  await expect(page.locator('iframe[title="研究看板预览"]')).toHaveCount(0);
  expect(fixture.starts).toBe(0);
  fixture.accept();
  await expect(preview(page)).toBeVisible();
  if (isMobile)
    await page
      .getByRole('navigation', { name: '移动端工作区视图' })
      .getByRole('button', { name: '文件', exact: true })
      .click();
  else await page.getByRole('button', { name: '显示项目文件', exact: true }).click();
  await page.getByRole('button', { name: 'a.ts', exact: true }).click();
  const count = fixture.reads;
  await expect.poll(() => fixture.reads, { timeout: 15_000 }).toBeGreaterThan(count);
  await expect(page.getByRole('textbox', { name: 'Code editor' })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('does not dispatch queued follow-ups when active-request polling loses its connection', async ({
  page,
  isMobile,
}) => {
  const fixture = await openWorkspace(page, true, 1);
  await expect(preview(page)).toBeVisible();
  if (isMobile)
    await page
      .getByRole('navigation', { name: '移动端工作区视图' })
      .getByRole('button', { name: '对话', exact: true })
      .click();
  await expect(page.getByRole('button', { name: '加入补充要求队列' })).toBeVisible();
  await page.getByRole('textbox', { name: '向 QuantPilot 发送消息' }).fill('完成当前研究后再比较行业暴露');
  await page.getByRole('button', { name: '加入补充要求队列' }).click();
  const count = fixture.activityReads;
  fixture.disconnectActivity();
  await expect.poll(() => fixture.activityReads).toBeGreaterThan(count + 1);
  await expect(page.getByRole('button', { name: '加入补充要求队列' })).toBeVisible();
  await expect(page.getByText('完成当前研究后再比较行业暴露', { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('keeps a stopped preview hidden when status is stale and permits an explicit restart', async ({ page }) => {
  const fixture = await openWorkspace(page);
  await expect(preview(page)).toBeVisible();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect.poll(() => fixture.stops).toBe(1);
  const count = fixture.reads;
  await expect.poll(() => fixture.reads).toBeGreaterThan(count);
  await expect(page.locator('iframe[title="研究看板预览"]')).toHaveCount(0);
  expect(fixture.starts).toBe(0);
  await page.getByRole('button', { name: '启动看板预览' }).click();
  await expect(preview(page)).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('can retry a failed publish and releases loading when deployment is immediately ready', async ({ page }) => {
  const fixture = await openWorkspace(page);
  await expect(preview(page)).toBeVisible();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Deployment failed. Please try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published successfully')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  expect(fixture.deployments).toBe(2);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('restores historical context estimates separately from cumulative token usage', async ({ page, isMobile }) => {
  const fixture = await openWorkspace(page, true, 0, {
    schemaVersion: 1,
    elapsedMs: 12_000,
    agentRunCount: 2,
    modelTurnCount: 4,
    inputTokens: 1200,
    outputTokens: 100,
    totalTokens: 1300,
    cachedInputTokens: 200,
    cacheMissInputTokens: 1000,
    reasoningTokens: 0,
    tokenAccounting: 'estimated',
    contextSnapshot: {
      schemaVersion: 1,
      runId: 'last-run',
      model: 'test-model',
      turn: 2,
      observedAt: 1_780_000_000_000,
      source: 'estimated',
      inputTokens: 600,
      inputBudgetTokens: 800,
      contextWindowTokens: 1000,
      reservedOutputTokens: 100,
      compacted: true,
    },
  });
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(preview(page)).toBeVisible();
    if (isMobile)
      await page
        .getByRole('navigation', { name: '移动端工作区视图' })
        .getByRole('button', { name: '对话', exact: true })
        .click();
    await expect(page.getByText('Tokens 约 1,300', { exact: true })).toBeVisible();
    await expect(page.getByLabel('末次上下文预估')).toHaveText('末次上下文约 600 / 800 Token（输入预算，已压缩）');
  }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
