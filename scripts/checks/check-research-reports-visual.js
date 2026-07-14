#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = path.join(__dirname, '..', '..');
const baseUrl = (process.env.QUANTPILOT_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'research-reports');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const views = [
  { id: 'overview', query: '', label: '研究总览', expected: '研究链路已经就绪' },
  { id: 'reports', query: '?view=reports', label: '报告库', expected: '研究报告库' },
  { id: 'insights', query: '?view=insights', label: '主题洞察', expected: '主题洞察与证据地图' },
  { id: 'automation', query: '?view=automation', label: '源与自动化', expected: '研究源与自动化链路' },
];

function cleanMessage(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function inspectProfile(browser, profile) {
  const context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: 1, colorScheme: profile.theme });
  await context.addInitScript((theme) => localStorage.setItem('quantpilot-color-mode', theme), profile.theme);
  const page = await context.newPage();
  const problems = [];
  const pageErrors = [];
  const failedResources = [];
  page.on('pageerror', (error) => pageErrors.push(cleanMessage(error.message)));
  page.on('response', (response) => {
    if (response.status() >= 400 && ['document', 'script', 'stylesheet', 'image', 'font'].includes(response.request().resourceType())) {
      failedResources.push(`${response.status()} ${response.request().resourceType()} ${response.url()}`);
    }
  });

  try {
    for (const view of views) {
      const response = await page.goto(`${baseUrl}/research-reports${view.query}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!response?.ok()) {
        problems.push(`${profile.id}/${view.id}: 文档请求返回 ${response?.status() ?? '无响应'}`);
        continue;
      }
      await page.waitForFunction(
        ({ label, expected }) => document.body.innerText.includes(label) && document.body.innerText.includes(expected),
        { label: view.label, expected: view.expected },
        { timeout: 20_000 },
      );
      await page.waitForTimeout(250);
      const layout = await page.evaluate(() => {
        const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
        const tablist = activeTab?.closest('[role="tablist"]');
        const activeRect = activeTab?.getBoundingClientRect();
        const tablistRect = tablist?.getBoundingClientRect();
        const metricTops = Array.from(document.querySelectorAll('[data-research-metric]'))
          .slice(0, 4)
          .map((node) => Math.round(node.getBoundingClientRect().top / 4));
        const dailyActions = Array.from(document.querySelectorAll('button')).filter((button) => {
          const label = `${button.getAttribute('aria-label') || ''} ${button.innerText}`;
          return label.includes('生成研究日报') || label.includes('生成日报');
        });
        return {
          width: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          mainWidth: document.querySelector('main')?.getBoundingClientRect().width ?? 0,
          mainHeight: document.querySelector('main')?.getBoundingClientRect().height ?? 0,
          headerHeight: document.querySelector('.platform-header')?.getBoundingClientRect().height ?? 0,
          selectedTabs: document.querySelectorAll('[role="tab"][aria-selected="true"]').length,
          activeTabVisible: Boolean(activeRect && tablistRect && activeRect.left >= tablistRect.left - 1 && activeRect.right <= tablistRect.right + 1),
          metricRows: new Set(metricTops).size,
          metricCount: metricTops.length,
          dailyActions: dailyActions.length,
          bodyTextLength: document.body.innerText.trim().length,
        };
      });
      if (layout.scrollWidth > layout.width + 2) problems.push(`${profile.id}/${view.id}: 页面横向溢出 (${layout.scrollWidth}px > ${layout.width}px)`);
      if (layout.mainWidth < 100 || layout.mainHeight < 100) problems.push(`${profile.id}/${view.id}: 主内容区域尺寸异常`);
      if (layout.selectedTabs !== 1) problems.push(`${profile.id}/${view.id}: 当前导航状态异常 (${layout.selectedTabs})`);
      if (!layout.activeTabVisible) problems.push(`${profile.id}/${view.id}: 当前导航标签未完整进入可视区`);
      if (layout.dailyActions !== 1) problems.push(`${profile.id}/${view.id}: 日报生成主入口数量异常 (${layout.dailyActions})`);
      if (profile.viewport.width < 640 && layout.headerHeight > 84) problems.push(`${profile.id}/${view.id}: 移动端顶栏过高 (${layout.headerHeight}px)`);
      if (profile.viewport.width < 640 && layout.metricCount === 4 && layout.metricRows > 2) problems.push(`${profile.id}/${view.id}: 移动端指标未压缩为两行 (${layout.metricRows})`);
      if (layout.bodyTextLength < 120) problems.push(`${profile.id}/${view.id}: 页面内容异常为空`);
      await page.screenshot({ path: path.join(outputDir, `${view.id}-${profile.id}-${timestamp}.png`) });
    }

    await page.goto(`${baseUrl}/research-reports?view=reports`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const search = page.getByLabel('搜索研究报告');
    await search.fill('候选');
    await search.fill('');
    const reportCard = page.getByRole('button', { name: /阅读报告/ }).first();
    if (await reportCard.count()) {
      await reportCard.click();
      await page.getByText('研究正文').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
    } else {
      await page.getByText('报告库等待首份研究日报').waitFor({ state: 'visible' });
    }

    await page.goto(`${baseUrl}/research-reports?view=automation`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('h2:visible').filter({ hasText: '观察池与生成计划' }).waitFor({ state: 'visible' });
    await page.locator('h2:visible').filter({ hasText: '数据与证据源矩阵' }).waitFor({ state: 'visible' });
  } catch (error) {
    problems.push(`${profile.id}: ${cleanMessage(error instanceof Error ? error.message : error)}`);
  } finally {
    problems.push(...pageErrors.map((item) => `${profile.id}: 页面运行错误 ${item}`));
    problems.push(...failedResources.map((item) => `${profile.id}: 静态资源失败 ${item}`));
    await context.close();
  }
  return problems;
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const profiles = [
    { id: 'desktop-light', viewport: { width: 1440, height: 900 }, theme: 'light' },
    { id: 'mobile-dark', viewport: { width: 390, height: 844 }, theme: 'dark' },
  ];
  const problems = [];
  try {
    for (const profile of profiles) problems.push(...await inspectProfile(browser, profile));
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.error(`\n❌ 投研情报中心视觉检查失败（${problems.length} 项）`);
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(`截图目录：${outputDir}`);
    process.exitCode = 1;
    return;
  }
  console.log('✅ 投研情报中心视觉检查通过：四个视图、紧凑顶栏、导航可见性、单一生成入口、移动指标密度与搜索均正常');
  console.log(`截图目录：${outputDir}`);
}

main().catch((error) => {
  console.error(`❌ 投研情报中心视觉检查异常：${cleanMessage(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
