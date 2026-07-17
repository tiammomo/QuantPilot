#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = path.join(__dirname, '..', '..');
const baseUrl = (process.env.QUANTPILOT_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'platforms');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const adminLogin = process.env.PLATFORM_ADMIN_LOGIN || 'admin';
const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD || 'admin';

const routes = [
  { id: 'home', path: '/', expected: 'QuantPilot' },
  { id: 'business', path: '/business-knowledge', expected: '量化业务知识中心' },
  { id: 'strategy', path: '/strategy-platform', expected: '策略平台' },
  { id: 'research', path: '/research-reports', expected: '投研情报中心' },
  { id: 'eval', path: '/eval-platform', expected: '质量总览' },
  { id: 'ops', path: '/ops-platform', expected: '运行治理中心' },
  { id: 'skills', path: '/skills', expected: 'QUANTPILOT SKILLS MARKET' },
  { id: 'account-usage', path: '/account/usage', expected: '用量与配额' },
  { id: 'account-security', path: '/account/security', expected: '密码与登录设备' },
];

const legacyRoutes = [
  ['/capabilities', '/business-knowledge'],
  ['/data-platform', '/business-knowledge'],
  ['/strategies', '/strategy-platform'],
  ['/workspaces', '/ops-platform'],
  ['/evals', '/eval-platform'],
  ['/observability', '/ops-platform'],
];

function cleanMessage(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function createAuthenticatedState(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
  });
  const page = await context.newPage();

  try {
    const response = await page.goto(`${baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (!response?.ok()) {
      throw new Error(`首页请求返回 ${response?.status() ?? '无响应'}`);
    }

    const identity = page.locator('#identity');
    if (new URL(page.url()).pathname === '/login' || await identity.isVisible().catch(() => false)) {
      await identity.fill(adminLogin);
      await page.locator('#password').fill(adminPassword);
      await page.locator('button[type="submit"]').click();
      await page.waitForFunction(
        () => window.location.pathname !== '/login',
        null,
        { timeout: 20_000 },
      );
    }

    if (new URL(page.url()).pathname === '/login') {
      const alert = await page.locator('[role="alert"]').textContent().catch(() => null);
      throw new Error(alert?.trim() || '默认管理员登录失败');
    }

    return await context.storageState();
  } finally {
    await context.close();
  }
}

async function discoverProjectRoute(request) {
  try {
    const response = await request.get(`${baseUrl}/api/projects`, { timeout: 15_000 });
    if (!response.ok()) return null;
    const payload = await response.json();
    const projects = Array.isArray(payload) ? payload : payload.projects ?? payload.data ?? [];
    const id = projects[0]?.id;
    return id ? { id: 'chat', path: `/${id}/chat?visualCheck=1`, expected: projects[0]?.name || 'QuantPilot' } : null;
  } catch {
    return null;
  }
}

async function inspectRoute(browser, storageState, route, profile) {
  const context = await browser.newContext({
    storageState,
    viewport: profile.viewport,
    deviceScaleFactor: 1,
    colorScheme: profile.theme,
  });
  await context.addInitScript((theme) => {
    localStorage.setItem('quantpilot-color-mode', theme);
  }, profile.theme);

  const page = await context.newPage();
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
    const response = await page.goto(`${baseUrl}${route.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    if (!response?.ok()) {
      return [`${profile.id}/${route.id}: 文档请求返回 ${response?.status() ?? '无响应'}`];
    }

    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForFunction(
      (expected) => document.body.innerText.includes(expected),
      route.expected,
      { timeout: 15_000 }
    );

    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyTextLength: document.body.innerText.trim().length,
      visibleMain: Array.from(document.querySelectorAll('main, [role="main"]')).some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }),
    }));

    const screenshotPath = path.join(outputDir, `${route.id}-${profile.id}-${timestamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: route.id === 'home' });

    const problems = [];
    if (layout.bodyTextLength < 30) problems.push(`${profile.id}/${route.id}: 页面内容异常为空`);
    if (!layout.visibleMain) problems.push(`${profile.id}/${route.id}: 未找到可见的主内容区域`);
    if (layout.scrollWidth > layout.width + 2) {
      problems.push(`${profile.id}/${route.id}: 页面发生横向溢出 (${layout.scrollWidth}px > ${layout.width}px)`);
    }
    problems.push(...pageErrors.map((item) => `${profile.id}/${route.id}: 页面运行错误 ${item}`));
    problems.push(...failedResources.map((item) => `${profile.id}/${route.id}: 静态资源失败 ${item}`));
    return problems;
  } catch (error) {
    return [`${profile.id}/${route.id}: ${cleanMessage(error instanceof Error ? error.message : error)}`];
  } finally {
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const problems = [];

  try {
    const storageState = await createAuthenticatedState(browser);
    const requestContext = await browser.newContext({ storageState });
    const projectRoute = await discoverProjectRoute(requestContext.request);
    await requestContext.close();
    const allRoutes = projectRoute ? [...routes, projectRoute] : routes;
    const profiles = [
      { id: 'desktop-light', viewport: { width: 1440, height: 900 }, theme: 'light' },
      { id: 'mobile-dark', viewport: { width: 390, height: 844 }, theme: 'dark' },
    ];

    for (const profile of profiles) {
      for (const route of allRoutes) {
        problems.push(...await inspectRoute(browser, storageState, route, profile));
      }
    }

    const redirectContext = await browser.newContext({ storageState });
    const redirectPage = await redirectContext.newPage();
    for (const [source, target] of legacyRoutes) {
      await redirectPage.goto(`${baseUrl}${source}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const finalUrl = new URL(redirectPage.url());
      if (finalUrl.pathname !== target) {
        problems.push(`历史路由 ${source} 未重定向到 ${target}，实际为 ${finalUrl.pathname}`);
      }
    }
    await redirectContext.close();
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.error(`\n❌ 全平台视觉检查失败（${problems.length} 项）`);
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(`截图目录：${outputDir}`);
    process.exitCode = 1;
    return;
  }

  console.log('✅ 全平台视觉检查通过：桌面亮色、移动端暗色及历史路由兼容均正常');
  console.log(`截图目录：${outputDir}`);
}

main().catch((error) => {
  console.error(`❌ 全平台视觉检查异常：${cleanMessage(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
