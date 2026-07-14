#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = path.join(__dirname, '..', '..');
const baseUrl = (process.env.QUANTPILOT_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'skills-market');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

function cleanMessage(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function inspectProfile(browser, profile) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: 1,
    colorScheme: profile.theme,
  });
  await context.addInitScript((theme) => localStorage.setItem('quantpilot-color-mode', theme), profile.theme);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
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
    const response = await page.goto(`${baseUrl}/skills`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!response?.ok()) {
      problems.push(`${profile.id}: 文档请求返回 ${response?.status() ?? '无响应'}`);
      return problems;
    }
    const market = page.locator('main:visible');
    await market.getByText('QUANTPILOT SKILLS MARKET', { exact: true }).waitFor({ state: 'visible' });
    await market.getByRole('heading', { name: '精选能力' }).waitFor({ state: 'visible' });
    await market.getByRole('heading', { name: '探索全部技能' }).waitFor({ state: 'attached' });

    const marketLayout = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headerHeight: document.querySelector('.platform-header')?.getBoundingClientRect().height ?? 0,
      cards: document.querySelectorAll('button[aria-label^="查看 "]').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      bodyTextLength: document.body.innerText.trim().length,
    }));
    if (marketLayout.scrollWidth > marketLayout.width + 2) problems.push(`${profile.id}: Market 横向溢出 (${marketLayout.scrollWidth}px > ${marketLayout.width}px)`);
    if (marketLayout.cards < 6) problems.push(`${profile.id}: 技能卡片数量异常 (${marketLayout.cards})`);
    if (marketLayout.dialogs !== 0) problems.push(`${profile.id}: 初始状态出现意外弹窗`);
    if (marketLayout.bodyTextLength < 400) problems.push(`${profile.id}: Market 内容异常为空`);
    if (profile.viewport.width < 640 && marketLayout.headerHeight > 112) problems.push(`${profile.id}: 移动端顶栏过高 (${marketLayout.headerHeight}px)`);
    await page.screenshot({ path: path.join(outputDir, `market-${profile.id}-${timestamp}.png`) });

    const firstSkill = market.locator('button[aria-label^="查看 "]').first();
    await firstSkill.scrollIntoViewIfNeeded();
    await firstSkill.click();
    const dialog = page.getByRole('dialog', { name: /运行规划|数据注册|标的解析|图片提取|行情数据/ });
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: '交付信息' }).click();
    await dialog.getByText('源码目录', { exact: true }).waitFor({ state: 'visible' });
    const dialogLayout = await page.evaluate(() => {
      const dialogNode = document.querySelector('[role="dialog"]');
      const rect = dialogNode?.getBoundingClientRect();
      return { width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, dialogWidth: rect?.width ?? 0, dialogHeight: rect?.height ?? 0 };
    });
    if (dialogLayout.scrollWidth > dialogLayout.width + 2) problems.push(`${profile.id}: 详情弹窗导致横向溢出`);
    if (dialogLayout.dialogWidth < 300 || dialogLayout.dialogHeight < 400) problems.push(`${profile.id}: 详情弹窗尺寸异常`);
    await page.screenshot({ path: path.join(outputDir, `detail-${profile.id}-${timestamp}.png`) });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    await page.locator('header:visible').getByRole('button', { name: 'Studio', exact: true }).click();
    const studio = page.locator('[role="main"]:visible');
    const editor = studio.getByLabel('Skill 源码编辑器');
    await editor.waitFor({ state: 'visible' });
    const studioLayout = await page.evaluate(() => {
      const editorNode = document.querySelector('[aria-label="Skill 源码编辑器"]');
      const editorRect = editorNode?.getBoundingClientRect();
      return {
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        editorWidth: editorRect?.width ?? 0,
        editorHeight: editorRect?.height ?? 0,
      };
    });
    if (studioLayout.scrollWidth > studioLayout.width + 2) problems.push(`${profile.id}: Studio 横向溢出 (${studioLayout.scrollWidth}px > ${studioLayout.width}px)`);
    if (studioLayout.editorWidth < 300 || studioLayout.editorHeight < 300) problems.push(`${profile.id}: Studio 编辑画布尺寸异常`);
    const wrapButton = studio.getByRole('button', { name: '关闭自动换行' });
    if ((await wrapButton.getAttribute('aria-pressed')) !== 'true') problems.push(`${profile.id}: Studio 默认换行状态异常`);
    const focusButton = studio.getByRole('button', { name: '进入专注模式' });
    await focusButton.click();
    await studio.getByRole('button', { name: '退出专注模式' }).waitFor({ state: 'visible' });
    await studio.getByRole('button', { name: '退出专注模式' }).click();
    if (profile.viewport.width >= 1024) {
      const collapseTree = studio.getByRole('button', { name: '收起文件树' }).last();
      await collapseTree.click();
      await studio.getByRole('button', { name: '展开文件树' }).waitFor({ state: 'visible' });
      await studio.getByRole('button', { name: '展开文件树' }).click();
    }
    await page.screenshot({ path: path.join(outputDir, `studio-${profile.id}-${timestamp}.png`) });
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
  const problems = [];
  const profiles = [
    { id: 'desktop-light', viewport: { width: 1440, height: 900 }, theme: 'light' },
    { id: 'mobile-dark', viewport: { width: 390, height: 844 }, theme: 'dark' },
  ];

  try {
    for (const profile of profiles) problems.push(...await inspectProfile(browser, profile));
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.error(`\n❌ Skills Market 视觉检查失败（${problems.length} 项）`);
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(`截图目录：${outputDir}`);
    process.exitCode = 1;
    return;
  }

  console.log('✅ Skills Market 视觉检查通过：市场首页、技能详情、交付信息、Studio、亮暗主题与移动端布局均正常');
  console.log(`截图目录：${outputDir}`);
}

main().catch((error) => {
  console.error(`❌ Skills Market 视觉检查异常：${cleanMessage(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
