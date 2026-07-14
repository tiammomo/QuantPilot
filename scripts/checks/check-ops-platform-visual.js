#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = path.join(__dirname, '..', '..');
const baseUrl = (process.env.QUANTPILOT_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'ops-platform');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const views = [
  { id: 'overview', query: '', label: '运行总览', expected: '系统当前可以运行，风险边界清晰可见' },
  { id: 'services', query: '?view=services', label: '服务治理', expected: '服务目录与运行底座' },
  { id: 'workspaces', query: '?view=workspaces', label: '工作空间', expected: '工作空间交付治理' },
  { id: 'trace', query: '?view=trace', label: '生成链路', expected: '生成链路观测' },
  { id: 'logs', query: '?view=logs', label: '运行日志', expected: '运行日志与故障现场' },
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
      const response = await page.goto(`${baseUrl}/ops-platform${view.query}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
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
      const layout = await page.evaluate(() => ({
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        mainWidth: document.querySelector('main')?.getBoundingClientRect().width ?? 0,
        mainHeight: document.querySelector('main')?.getBoundingClientRect().height ?? 0,
        selectedTabs: document.querySelectorAll('[role="tab"][aria-selected="true"]').length,
        bodyTextLength: document.body.innerText.trim().length,
      }));
      if (layout.scrollWidth > layout.width + 2) problems.push(`${profile.id}/${view.id}: 页面横向溢出 (${layout.scrollWidth}px > ${layout.width}px)`);
      if (layout.mainWidth < 100 || layout.mainHeight < 100) problems.push(`${profile.id}/${view.id}: 主内容区域尺寸异常`);
      if (layout.selectedTabs !== 1) problems.push(`${profile.id}/${view.id}: 当前导航状态异常 (${layout.selectedTabs})`);
      if (layout.bodyTextLength < 180) problems.push(`${profile.id}/${view.id}: 页面内容异常为空`);
      await page.screenshot({ path: path.join(outputDir, `${view.id}-${profile.id}-${timestamp}.png`) });
    }

    await page.goto(`${baseUrl}/ops-platform?view=services`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByLabel('搜索服务').fill('TimescaleDB');
    await page.getByRole('button', { name: /PostgreSQL \/ TimescaleDB/ }).first().click();
    await page.getByText('连接与依赖').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');

    await page.goto(`${baseUrl}/ops-platform?view=workspaces`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const workspaceCard = page.getByRole('button', { name: /查看治理详情/ }).first();
    if (await workspaceCard.count()) {
      await workspaceCard.click();
      await page.getByText('交付产物').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
    }

    await page.goto(`${baseUrl}/ops-platform?view=logs`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByLabel('搜索日志').fill('INFO');
    await page.getByText(/匹配 \d+\/\d+ 行/).waitFor({ state: 'visible' });
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
    console.error(`\n❌ 运行治理中心视觉检查失败（${problems.length} 项）`);
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(`截图目录：${outputDir}`);
    process.exitCode = 1;
    return;
  }
  console.log('✅ 运行治理中心视觉检查通过：五个视图、桌面亮色、移动端暗色、搜索与详情钻取均正常');
  console.log(`截图目录：${outputDir}`);
}

main().catch((error) => {
  console.error(`❌ 运行治理中心视觉检查异常：${cleanMessage(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
