#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = path.join(__dirname, '..', '..');
const homepageUrl = new URL(process.env.HOMEPAGE_URL || 'http://localhost:3000/');
const baseUrl = homepageUrl.origin;
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'homepage');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const adminLogin = process.env.HOMEPAGE_ADMIN_LOGIN || 'admin';
const adminPassword = process.env.HOMEPAGE_ADMIN_PASSWORD || 'admin';

const profiles = [
  { id: 'wide-light', viewport: { width: 2048, height: 1152 }, theme: 'light', touch: false },
  { id: 'desktop-light', viewport: { width: 1440, height: 900 }, theme: 'light', touch: false },
  { id: 'desktop-dark', viewport: { width: 1440, height: 900 }, theme: 'dark', touch: false },
  { id: 'tablet-light', viewport: { width: 768, height: 1024 }, theme: 'light', touch: true },
  { id: 'tablet-dark', viewport: { width: 768, height: 1024 }, theme: 'dark', touch: true },
  { id: 'mobile-light', viewport: { width: 390, height: 844 }, theme: 'light', touch: true },
  { id: 'mobile-dark', viewport: { width: 390, height: 844 }, theme: 'dark', touch: true },
];

function cleanMessage(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function fail(message, details = []) {
  console.error(`\n❌ 首页技术 UX 检查失败：${message}`);
  for (const detail of details) console.error(`- ${detail}`);
  process.exitCode = 1;
}

async function createAuthenticatedState(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
  });
  const page = await context.newPage();

  try {
    const response = await page.goto(homepageUrl.href, {
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

      if (new URL(page.url()).pathname === '/login') {
        const alert = await page.locator('[role="alert"]').textContent().catch(() => null);
        throw new Error(alert?.trim() || '默认管理员登录失败');
      }
    }

    await page.locator('textarea[aria-label="量化分析需求"]').waitFor({
      state: 'visible',
      timeout: 20_000,
    });

    return await context.storageState();
  } finally {
    await context.close();
  }
}

async function inspectDrawer(page, profile) {
  let projectButton = page.getByRole('button', { name: /^项目/ }).first();
  if (!await projectButton.isVisible().catch(() => false)) {
    projectButton = page.getByRole('button', { name: /^查看全部/ }).first();
  }
  if (!await projectButton.isVisible().catch(() => false)) {
    return { available: false, problems: [`${profile.id}: 未找到项目抽屉入口`] };
  }

  await projectButton.click();
  const search = page.locator('input[aria-label="搜索任务记录"]');
  await search.waitFor({ state: 'visible', timeout: 5_000 });

  const result = await page.evaluate(({ touch }) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const actions = Array.from(document.querySelectorAll('.task-drawer-actions button')).filter(visible);
    return {
      actionCount: actions.length,
      actions: actions.slice(0, 2).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.getAttribute('aria-label') || '',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          opacity: Number(getComputedStyle(element.parentElement).opacity),
        };
      }),
      touch,
    };
  }, { touch: profile.touch });

  const problems = [];
  if (result.actionCount > 0) {
    const firstAction = page.locator('.task-drawer-actions button').first();
    await firstAction.focus();
    await page.waitForTimeout(200);
    const focusedOpacity = await firstAction.evaluate((element) => Number(getComputedStyle(element.parentElement).opacity));
    if (focusedOpacity < 0.99) problems.push(`${profile.id}: 抽屉操作获得键盘焦点后仍不可见`);

    for (const action of result.actions) {
      if (action.width < 44 || action.height < 44) {
        problems.push(`${profile.id}: ${action.name || '抽屉操作'} 仅 ${action.width}×${action.height}px`);
      }
      if (profile.touch && action.opacity < 0.99) {
        problems.push(`${profile.id}: 触屏下 ${action.name || '抽屉操作'} 默认不可见`);
      }
    }
  }

  await page.keyboard.press('Escape');
  return { available: true, ...result, problems };
}

async function inspectProfile(browser, storageState, profile) {
  const context = await browser.newContext({
    storageState,
    viewport: profile.viewport,
    colorScheme: profile.theme,
    hasTouch: profile.touch,
    isMobile: profile.touch,
    reducedMotion: 'no-preference',
    deviceScaleFactor: 1,
  });
  await context.addInitScript((theme) => {
    localStorage.setItem('quantpilot-color-mode', theme);
  }, profile.theme);

  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedResources = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(cleanMessage(message.text()));
  });
  page.on('pageerror', (error) => pageErrors.push(cleanMessage(error.message)));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const type = response.request().resourceType();
    if (['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'xhr'].includes(type)) {
      failedResources.push(`${response.status()} ${type} ${response.url()}`);
    }
  });

  try {
    const response = await page.goto(homepageUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (!response?.ok()) {
      return { profile: profile.id, problems: [`文档请求返回 ${response?.status() ?? '无响应'}`] };
    }
    if (new URL(page.url()).pathname === '/login') {
      return { profile: profile.id, problems: ['登录会话未能复用，首页重新跳转到 /login'] };
    }

    await page.locator('textarea[aria-label="量化分析需求"]').waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(350);

    const metrics = await page.evaluate(({ expectedTheme, touch }) => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: Number(rect.left.toFixed(1)),
          right: Number(rect.right.toFixed(1)),
          top: Number(rect.top.toFixed(1)),
          bottom: Number(rect.bottom.toFixed(1)),
          width: Number(rect.width.toFixed(1)),
          height: Number(rect.height.toFixed(1)),
        };
      };
      const name = (element) => cleanText(
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.textContent ||
        '',
      );
      function cleanText(value) {
        return String(value).replace(/\s+/g, ' ').trim().slice(0, 80);
      }

      const form = document.querySelector('#task-input form');
      const content = document.querySelector('main.platform-content > div');
      const header = document.querySelector('header');
      const submit = document.querySelector('button[aria-label="提交任务"]');
      const mobileNav = document.querySelector('nav[aria-label="移动端首页导航"]');
      const headerTargets = header
        ? Array.from(header.querySelectorAll('a[href], button')).filter(visible)
        : [];
      const headerOverlaps = [];

      for (let leftIndex = 0; leftIndex < headerTargets.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < headerTargets.length; rightIndex += 1) {
          const left = headerTargets[leftIndex];
          const right = headerTargets[rightIndex];
          if (left.contains(right) || right.contains(left)) continue;
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapWidth > 2 && overlapHeight > 2) {
            headerOverlaps.push(`${name(left) || left.tagName} ↔ ${name(right) || right.tagName}`);
          }
        }
      }

      const keyTargets = [];
      if (submit && visible(submit)) keyTargets.push({ name: '提交任务', ...box(submit) });
      if (touch && mobileNav && visible(mobileNav)) {
        for (const button of mobileNav.querySelectorAll('button')) {
          if (visible(button)) keyTargets.push({ name: `底部导航/${name(button)}`, ...box(button) });
        }
      }

      const resources = performance.getEntriesByType('resource');
      const stableFallback = resources.filter((entry) => entry.name.includes('/generated/quantpilot-tailwind.css'));
      const styleResources = resources
        .filter((entry) => entry.initiatorType === 'link' && entry.name.includes('.css'))
        .map((entry) => ({
          name: entry.name,
          transferSize: entry.transferSize || 0,
          decodedBodySize: entry.decodedBodySize || 0,
        }));
      const formBox = form ? box(form) : null;
      const contentBox = content ? box(content) : null;

      return {
        expectedTheme,
        actualTheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        colorScheme: document.documentElement.style.colorScheme,
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        form: formBox,
        content: contentBox,
        contentSideGutter: contentBox
          ? Number(((innerWidth - contentBox.width) / 2).toFixed(1))
          : null,
        formCenterOffset: formBox ? Number((((formBox.left + formBox.right) / 2) - innerWidth / 2).toFixed(1)) : null,
        headerOverlaps,
        keyTargets,
        stableFallbackCount: stableFallback.length,
        styleResources,
      };
    }, { expectedTheme: profile.theme, touch: profile.touch });

    const screenshotPath = path.join(outputDir, `${profile.id}-${timestamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const drawer = await inspectDrawer(page, profile);

    const problems = [];
    if (!metrics.form) problems.push(`${profile.id}: 未找到主任务表单`);
    if (Math.abs(metrics.formCenterOffset ?? 999) > 2) {
      problems.push(`${profile.id}: 主任务表单未居中，偏移 ${metrics.formCenterOffset}px`);
    }
    if (metrics.viewport.width >= 1800 && (metrics.contentSideGutter ?? Infinity) > 112) {
      problems.push(`${profile.id}: 宽屏内容两侧留白过大，单侧 ${metrics.contentSideGutter}px`);
    }
    if (metrics.documentWidth > metrics.viewport.width + 2) {
      problems.push(`${profile.id}: 整页横向溢出 ${metrics.documentWidth}px > ${metrics.viewport.width}px`);
    }
    for (const overlap of metrics.headerOverlaps) {
      problems.push(`${profile.id}: 顶栏交互控件重叠 ${overlap}`);
    }
    if (metrics.actualTheme !== profile.theme || metrics.colorScheme !== profile.theme) {
      problems.push(`${profile.id}: 主题未正确生效（${metrics.actualTheme}/${metrics.colorScheme}）`);
    }
    if (profile.touch) {
      for (const target of metrics.keyTargets) {
        if (target.width < 44 || target.height < 44) {
          problems.push(`${profile.id}: 关键触控目标 ${target.name} 仅 ${target.width}×${target.height}px`);
        }
      }
    }
    if (metrics.stableFallbackCount > 0 && process.env.QUANTPILOT_STABLE_CSS_FALLBACK !== '1') {
      problems.push(`${profile.id}: 默认运行时仍加载重复的 quantpilot-tailwind.css`);
    }
    problems.push(...drawer.problems);
    problems.push(...failedResources.map((item) => `${profile.id}: 资源失败 ${item}`));
    problems.push(...pageErrors.map((item) => `${profile.id}: 页面运行错误 ${item}`));
    problems.push(...consoleErrors.map((item) => `${profile.id}: console error ${item}`));

    return {
      profile: profile.id,
      screenshotPath,
      metrics,
      drawer,
      failedResources,
      pageErrors,
      consoleErrors,
      problems,
    };
  } finally {
    await context.close();
  }
}

async function inspectSubmissionRecovery(browser, storageState) {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const problems = [];
  const projectBodies = [];
  const actBodies = [];
  let actAttempts = 0;

  await page.route('**/api/projects*', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname !== '/api/projects') return route.fallback();
    if (request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      });
    }
    if (request.method() === 'POST') {
      projectBodies.push(request.postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { id: 'project-homepage-check' } }),
      });
    }
    return route.fallback();
  });

  await page.route('**/api/chat/project-homepage-check/act', async (route) => {
    actAttempts += 1;
    actBodies.push(route.request().postDataJSON());
    if (actAttempts === 1) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, message: '模拟 Agent 启动失败' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: 'accepted' }),
    });
  });

  try {
    await page.goto(homepageUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const textarea = page.locator('textarea[aria-label="量化分析需求"]');
    const submit = page.locator('button[aria-label="提交任务"]');
    await textarea.waitFor({ state: 'visible', timeout: 20_000 });

    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nLkAAAAASUVORK5CYII=',
      'base64',
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: 'homepage-check.png',
      mimeType: 'image/png',
      buffer: onePixelPng,
    });
    await page.getByText('已添加图片，请补充文字说明后再开始研究。').waitFor();
    if (!await submit.isDisabled()) problems.push('图片-only 状态下提交按钮仍可用');
    if (projectBodies.length > 0) problems.push('图片-only 状态在填写问题前创建了项目');
    await page.getByRole('button', { name: /移除图片/ }).click();

    const question = '分析贵州茅台近 60 个交易日的趋势和主要风险';
    await textarea.fill(question);
    await page.getByRole('button', { name: '只做问答' }).click();
    await submit.click();
    await page.getByText(/模拟 Agent 启动失败/).waitFor({ timeout: 10_000 });

    if (await textarea.inputValue() !== question) problems.push('Agent 启动失败后首页清空了用户问题');
    if (new URL(page.url()).pathname !== '/') problems.push('Agent 启动失败后首页仍发生了导航');
    if (projectBodies.length !== 1) problems.push(`首次失败流程创建了 ${projectBodies.length} 个项目，预期 1 个`);
    if (actBodies.length !== 1) problems.push(`首次失败流程调用了 ${actBodies.length} 次 Agent，预期 1 次`);

    await submit.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const button = document.querySelector('button[aria-label="提交任务"]');
      return button && !button.hasAttribute('disabled');
    });
    await submit.click();
    await page.waitForURL((url) => url.pathname === '/project-homepage-check/chat', { timeout: 10_000 });

    const finalUrl = new URL(page.url());
    if (projectBodies.length !== 1) problems.push('重试时重复创建了研究项目');
    if (actBodies.length !== 2) problems.push(`重试后 Agent 总调用次数为 ${actBodies.length}，预期 2 次`);
    if (finalUrl.searchParams.get('mode') !== 'chat') problems.push('只做问答模式未传递到 Workspace');
    if (!String(actBodies[0]?.instruction || '').includes('Do not modify code')) problems.push('只做问答模式未写入执行约束');
    if (actBodies[0]?.displayInstruction !== question) problems.push('首问没有保留用户可见原文');

    return {
      profile: 'submission-recovery',
      projectRequestCount: projectBodies.length,
      actRequestCount: actBodies.length,
      mode: finalUrl.searchParams.get('mode'),
      problems,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let storageState = null;

  try {
    storageState = await createAuthenticatedState(browser);
    const results = [];
    for (const profile of profiles) {
      results.push(await inspectProfile(browser, storageState, profile));
    }
    results.push(await inspectSubmissionRecovery(browser, storageState));

    const reportPath = path.join(outputDir, `report-${timestamp}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
    const problems = results.flatMap((result) => result.problems || []);

    if (problems.length > 0) {
      fail('响应式、可访问性或资源检查未通过', problems);
      console.error(`详细报告：${reportPath}`);
      return;
    }

    console.log('✅ 首页技术 UX 检查通过');
    console.log(`地址：${homepageUrl.href}`);
    console.log(`覆盖：${profiles.map((profile) => profile.id).join(', ')}`);
    console.log('交互：图片-only 拦截、首问失败保留、幂等重试、问答模式传递');
    console.log(`详细报告：${reportPath}`);
  } finally {
    if (storageState) {
      const cleanupContext = await browser.newContext({ storageState }).catch(() => null);
      if (cleanupContext) {
        await cleanupContext.request.post(`${baseUrl}/api/auth/sign-out`).catch(() => {});
        await cleanupContext.close();
      }
    }
    await browser.close();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
