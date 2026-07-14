#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = path.join(__dirname, '..', '..');
const url = process.env.HOMEPAGE_URL || 'http://localhost:3000/';
const outputDir = path.join(rootDir, 'tmp', 'visual-checks');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const screenshotPath = path.join(outputDir, `homepage-${timestamp}.png`);

function fail(message, details = []) {
  console.error(`\n❌ 首页截图检查失败：${message}`);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
  process.exitCode = 1;
}

async function assertVisible(page, selector, label) {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: 5000 });
    return true;
  } catch {
    return `${label} 不可见：${selector}`;
  }
}

async function assertAnyVisible(page, selectors, label) {
  for (const selector of selectors) {
    const result = await assertVisible(page, selector, label);
    if (result === true) {
      return true;
    }
  }
  return `${label} 不可见：${selectors.join(' 或 ')}`;
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const consoleErrors = [];
  const pageErrors = [];
  const failedResources = [];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  page.on('response', (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    if (
      response.status() >= 400 &&
      ['document', 'script', 'stylesheet', 'image', 'font'].includes(resourceType)
    ) {
      failedResources.push(`${response.status()} ${resourceType} ${response.url()}`);
    }
  });

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    if (!response || !response.ok()) {
      fail(`首页请求异常：${response ? response.status() : '无响应'}`);
      return;
    }

    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForFunction(
      () =>
        Object.getOwnPropertyNames(document.querySelector('button') || {}).some((key) =>
          key.startsWith('__react')
        ),
      { timeout: 12000 }
    ).catch(() => {});
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const hydrated = await page.evaluate(() =>
      Object.getOwnPropertyNames(document.querySelector('button') || {}).some((key) =>
        key.startsWith('__react')
      )
    );

    const checks = await Promise.all([
      assertVisible(page, 'text=QuantPilot', 'QuantPilot 标识'),
      assertVisible(page, 'text=量化分析', '首页主标题'),
      assertVisible(page, 'textarea[placeholder*="贵州茅台"]', '任务输入框'),
      assertVisible(page, 'button[aria-label="提交任务"]', '任务提交按钮'),
      assertVisible(page, 'button:has-text("最近任务")', '最近任务入口'),
      assertVisible(page, 'button:has-text("策略")', '策略平台入口'),
      assertVisible(page, 'button:has-text("治理")', '运行治理中心入口'),
      assertVisible(page, 'button:has-text("业务")', '业务知识中心入口'),
      assertVisible(page, 'button:has-text("评测")', '评测平台入口'),
      assertAnyVisible(page, ['button[title="亮色"]', 'button:has-text("亮色")'], '亮色模式入口'),
      assertAnyVisible(page, ['button[title="暗色"]', 'button:has-text("暗色")'], '暗色模式入口'),
      assertVisible(page, 'button:has-text("DeepSeek Agent")', 'DeepSeek Agent 入口'),
      assertVisible(page, 'button:has-text("DeepSeek V4 Flash")', '唯一模型入口'),
      assertVisible(page, 'button:has-text("个股诊断")', '个股诊断能力卡'),
      assertVisible(page, 'button:has-text("技术分析")', '技术分析能力卡'),
      assertVisible(page, 'button:has-text("基本面分析")', '基本面分析能力卡'),
      assertVisible(page, 'button:has-text("持仓分析")', '持仓分析能力卡'),
    ]);

    const visibleFailures = checks.filter((result) => result !== true);
    const problems = [
      ...(hydrated ? [] : ['首页未完成 React 客户端水合，按钮事件不会生效']),
      ...visibleFailures,
      ...failedResources.map((item) => `静态资源失败：${item}`),
      ...pageErrors.map((item) => `页面运行错误：${item}`),
    ];

    if (problems.length > 0) {
      fail('关键页面元素或资源不符合预期', problems);
      console.error(`截图已保存：${screenshotPath}`);
      return;
    }

    if (consoleErrors.length > 0) {
      console.warn(`⚠️  检测到 ${consoleErrors.length} 条浏览器 console error，未阻断截图检查。`);
      for (const item of consoleErrors.slice(0, 5)) {
        console.warn(`- ${item}`);
      }
    }

    console.log('✅ 首页截图检查通过');
    console.log(`URL：${url}`);
    console.log(`截图：${screenshotPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
