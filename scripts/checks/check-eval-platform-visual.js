#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = path.join(__dirname, '..', '..');
const baseUrl = (process.env.QUANTPILOT_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'eval-platform');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const views = [
  { id: 'overview', query: '', label: '质量总览', expected: '质量基线' },
  { id: 'cases', query: '?view=cases', label: '测试用例', expected: '用例资产库' },
  { id: 'evalSets', query: '?view=evalSets', label: '评测集', expected: '评测集资产库' },
  { id: 'evaluator', query: '?view=evaluator', label: '评测器', expected: '本次评测计划' },
  { id: 'queue', query: '?view=queue', label: '运行历史', expected: '执行中心' },
];

function cleanMessage(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function inspectProfile(browser, profile) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: 1,
    colorScheme: profile.theme,
  });
  await context.addInitScript((theme) => {
    localStorage.setItem('quantpilot-color-mode', theme);
  }, profile.theme);

  const page = await context.newPage();
  const problems = [];
  const pageErrors = [];
  const failedResources = [];
  page.on('pageerror', (error) => pageErrors.push(cleanMessage(error.message)));
  page.on('response', (response) => {
    const type = response.request().resourceType();
    if (response.status() >= 400 && ['document', 'script', 'stylesheet', 'image', 'font'].includes(type)) {
      failedResources.push(`${response.status()} ${type} ${response.url()}`);
    }
  });

  try {
    for (const view of views) {
      const response = await page.goto(`${baseUrl}/eval-platform${view.query}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      if (!response?.ok()) {
        problems.push(`${profile.id}/${view.id}: 文档请求返回 ${response?.status() ?? '无响应'}`);
        continue;
      }

      await page.waitForFunction(
        ({ label, expected }) => document.body.innerText.includes(label) && document.body.innerText.includes(expected),
        { label: view.label, expected: view.expected },
        { timeout: 15_000 },
      );
      await page.waitForTimeout(250);

      const layout = await page.evaluate(() => {
        const main = document.querySelector('main');
        const activeNavigation = document.querySelectorAll('[aria-current="page"]');
        return {
          width: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          mainWidth: main?.getBoundingClientRect().width ?? 0,
          mainHeight: main?.getBoundingClientRect().height ?? 0,
          activeNavigationCount: activeNavigation.length,
          bodyTextLength: document.body.innerText.trim().length,
        };
      });

      if (layout.scrollWidth > layout.width + 2) problems.push(`${profile.id}/${view.id}: 页面横向溢出 (${layout.scrollWidth}px > ${layout.width}px)`);
      if (layout.mainWidth < 100 || layout.mainHeight < 100) problems.push(`${profile.id}/${view.id}: 主内容区域尺寸异常`);
      if (layout.activeNavigationCount < 1) problems.push(`${profile.id}/${view.id}: 缺少当前视图导航状态`);
      if (layout.bodyTextLength < 120) problems.push(`${profile.id}/${view.id}: 页面内容异常为空`);

      const screenshotPath = path.join(outputDir, `${view.id}-${profile.id}-${timestamp}.png`);
      await page.screenshot({ path: screenshotPath });
    }

    await page.goto(`${baseUrl}/eval-platform?view=cases`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByRole('button', { name: '新增用例' }).click();
    await page.getByRole('heading', { name: '新增测试用例' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '取消' }).click();

    await page.goto(`${baseUrl}/eval-platform?view=evalSets`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByRole('button', { name: '创建评测集' }).click();
    await page.getByRole('heading', { name: '创建评测集' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '取消' }).click();

    await page.goto(`${baseUrl}/eval-platform?view=evaluator`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByRole('button', { name: /Agent 评测器/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Agent 评测器 · 并发'));

    await page.goto(`${baseUrl}/eval-platform?view=queue`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const autoRefresh = page.getByRole('checkbox', { name: '自动刷新' });
    await autoRefresh.check();
    if (!(await autoRefresh.isChecked())) problems.push(`${profile.id}/queue: 自动刷新开关不可用`);
    await autoRefresh.uncheck();
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
    console.error(`\n❌ 评测平台视觉检查失败（${problems.length} 项）`);
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(`截图目录：${outputDir}`);
    process.exitCode = 1;
    return;
  }

  console.log('✅ 评测平台视觉检查通过：五个视图、桌面亮色、移动端暗色及关键无写入交互均正常');
  console.log(`截图目录：${outputDir}`);
}

main().catch((error) => {
  console.error(`❌ 评测平台视觉检查异常：${cleanMessage(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
