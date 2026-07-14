#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = path.join(__dirname, '..', '..');
const baseUrl = (process.env.QUANTPILOT_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'business-knowledge');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const views = [
  { id: 'overview', query: '', label: '业务总览', expected: '把业务问题，映射为可执行的量化能力' },
  { id: 'capabilities', query: '?view=capabilities', label: '能力目录', expected: '量化业务能力目录' },
  { id: 'knowledge', query: '?view=knowledge', label: '业务知识', expected: '业务知识与交付规范' },
  { id: 'resources', query: '?view=resources', label: '支撑资源', expected: '业务能力背后的支撑资源' },
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
      const response = await page.goto(`${baseUrl}/business-knowledge${view.query}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!response?.ok()) {
        problems.push(`${profile.id}/${view.id}: 文档请求返回 ${response?.status() ?? '无响应'}`);
        continue;
      }
      await page.waitForFunction(
        ({ label, expected }) => document.body.innerText.includes(label) && document.body.innerText.includes(expected),
        { label: view.label, expected: view.expected },
        { timeout: 15_000 },
      );
      await page.waitForTimeout(350);
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

    await page.goto(`${baseUrl}/business-knowledge?view=capabilities`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const search = page.getByPlaceholder('搜索业务能力、场景或关注点...');
    await search.fill('持仓');
    await page.getByRole('button', { name: /持仓分析/ }).waitFor({ state: 'visible' });
    await search.fill('');
    await page.getByRole('button', { name: /个股诊断/ }).first().click();
    await page.getByRole('heading', { name: '个股诊断' }).waitFor({ state: 'visible' });
    await page.getByText('典型业务场景').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
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
    console.error(`\n❌ 业务知识中心视觉检查失败（${problems.length} 项）`);
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(`截图目录：${outputDir}`);
    process.exitCode = 1;
    return;
  }
  console.log('✅ 业务知识中心视觉检查通过：四个视图、桌面亮色、移动端暗色、搜索及知识详情均正常');
  console.log(`截图目录：${outputDir}`);
}

main().catch((error) => {
  console.error(`❌ 业务知识中心视觉检查异常：${cleanMessage(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
