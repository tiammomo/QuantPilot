import { expect, test } from 'playwright/test';

const fixtureSkill = {
  id: 'fixture-skill', name: '测试研究技能', scope: 'quant', version: '1.0.0', status: 'stable',
  boundary: '仅用于验证市场界面状态的合成能力', inputs: ['行情'], outputs: ['指标'], validation: ['样本一致'],
  health: 'ok', integrityProblems: [], packageVerified: true, packageSha256: 'a'.repeat(64),
  releases: [{ version: '1.0.0', date: '2026-09-18', summary: '测试版本', changes: ['合成证据'] }],
  capabilities: ['technical_analysis'], phases: [{ phase: 'data-preparation', compatible: true, missingTools: [], missingAlternative: false, phaseAllowed: true }],
  requiredTools: ['quant_api_get'], toolAlternatives: [], activation: 'task-selected',
};
const catalog = { generatedAt: '2026-09-18T00:00:00Z', skills: [fixtureSkill], capabilities: [{ id: 'technical_analysis', name: '技术分析', status: 'ready' }], project: null };

test('built-in catalog filters, inspects versions, downloads verified content and opens Studio', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const editorRequests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/skills') editorRequests.push(request.url()); });
  await page.goto('/skills');
  const cards = page.getByRole('button', { name: /^查看 / });
  await expect(cards).toHaveCount(12);
  await page.getByLabel('搜索技能').fill('quant-market-data');
  await expect(cards).toHaveCount(1);
  await page.getByLabel('能力域', { exact: true }).selectOption('platform');
  await expect(page.getByText('没有匹配的技能', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).first().click();
  await expect(cards).toHaveCount(12);
  await page.getByLabel('兼容阶段').selectOption('platform-ui');
  await expect(cards).toHaveCount(1);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  const first = cards.first(); await first.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '运行兼容性' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '版本记录' })).toBeAttached();
  const link = dialog.getByRole('link', { name: '下载已验证版本' });
  const response = await page.request.get((await link.getAttribute('href'))!);
  expect(response.status()).toBe(200); expect(response.headers()['x-content-sha256']).toMatch(/^sha256:[a-f0-9]{64}$/);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(first).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('skills-market.png') });
  expect(editorRequests).toEqual([]);
  await first.click(); await page.getByRole('button', { name: '在 Studio 中打开' }).click();
  await expect(page.getByLabel('Skill 源码编辑器')).toBeVisible();
  expect(page.url()).toContain('view=studio');
  expect(errors).toEqual([]);
});

test('project transitions and errors never retain a previous verified installation', async ({ page }) => {
  await page.route('**/api/projects', route => route.fulfill({ json: { success: true, data: [{ id: 'a', name: '项目甲' }, { id: 'b', name: '项目乙' }] } }));
  let releaseB: (() => void) | undefined;
  let fail = false;
  await page.route('**/api/skills/market**', async route => {
    const id = new URL(route.request().url()).searchParams.get('projectId');
    if (id === 'b') await new Promise<void>(resolve => { releaseB = resolve; });
    if (fail) { await route.fulfill({ status: 503, json: { success: false, error: '测试核验失败' } }); return; }
    await route.fulfill({ json: { success: true, data: { ...catalog, project: id ? { id, receiptStatus: 'present', installedAt: null, skills: [{ skillId: fixtureSkill.id, state: id === 'a' ? 'current' : 'modified', installedVersion: '1.0.0', expectedVersion: '1.0.0' }] } : null } } });
  });
  await page.goto('/skills');
  await expect(page.getByRole('button', { name: '查看 测试研究技能' })).toBeVisible();
  await page.getByLabel('项目安装状态', { exact: true }).selectOption('a');
  await expect(page.getByText('项目：版本一致', { exact: true })).toBeVisible();
  await page.getByLabel('项目安装状态', { exact: true }).selectOption('b');
  await expect(page.getByText('项目：版本一致', { exact: true })).not.toBeVisible();
  await expect(page.getByText('项目：核验中', { exact: true })).toBeVisible();
  await expect.poll(() => Boolean(releaseB)).toBe(true);
  await page.getByLabel('项目安装状态', { exact: true }).selectOption('a');
  await expect(page.getByText('项目：版本一致', { exact: true })).toBeVisible();
  releaseB!();
  await expect(page.getByText('项目：文件已修改', { exact: true })).not.toBeVisible();
  fail = true; await page.getByRole('button', { name: '重新核验' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '测试核验失败' })).toBeVisible();
  await expect(page.getByText('项目：版本一致', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '查看 测试研究技能' }).click();
  await expect(page.getByRole('button', { name: '校验通过后可下载' })).toBeDisabled();
});

test('unverified package details explain compatibility and disable downloads', async ({ page }) => {
  await page.route('**/api/skills/market', route => route.fulfill({ json: { success: true, data: { ...catalog, skills: [{ ...fixtureSkill, packageVerified: false, phases: [{ ...fixtureSkill.phases[0], compatible: false, missingTools: ['quant_api_get'] }] }] } } }));
  await page.goto('/skills');
  await page.getByRole('button', { name: '查看 测试研究技能' }).click();
  await expect(page.getByRole('dialog')).toContainText('不兼容，缺少 quant_api_get');
  await expect(page.getByRole('button', { name: '校验通过后可下载' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByLabel('仅显示完整性已验证').check();
  await expect(page.getByText('没有匹配的技能', { exact: true })).toBeVisible();
});
