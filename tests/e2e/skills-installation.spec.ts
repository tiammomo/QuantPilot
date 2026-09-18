import { expect, test } from 'playwright/test';

test('market installation selects an Agent, carries the version token and exposes conflicts', async ({ page }) => {
  const skill = { id: 'fixture-skill', name: '安装流程测试技能', scope: 'quant', version: '1.0.0', status: 'stable', boundary: '合成界面合同',
    inputs: [], outputs: [], validation: [], health: 'ok', integrityProblems: [], packageVerified: true, packageSha256: 'a'.repeat(64),
    releases: [{ version: '1.0.0', date: '2026-09-18', summary: 'fixture', changes: [], installable: true }],
    capabilities: [], phases: [], requiredTools: ['quant_api_get'], toolAlternatives: [], activation: 'task-selected' };
  const targets = [{ id: 'pi-agent', label: 'PI Agent' }, { id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];
  const revision = '0a58305a-8173-4f96-8d99-0fead816bfc2';
  let installed = false; const mutations: Record<string, unknown>[] = [];
  await page.route('**/api/projects', route => route.fulfill({ json: { success: true, data: [{ id: 'fixture-project', name: '安装测试项目' }] } }));
  await page.route('**/api/skills/market**', route => {
    const query = new URL(route.request().url()).searchParams;
    const id = query.get('projectId'); const target = query.get('target') ?? 'pi-agent';
    return route.fulfill({ json: { success: true, data: { generatedAt: new Date().toISOString(), skills: [skill], capabilities: [], targets,
      project: id ? { id, target, installedAt: null, receiptStatus: installed ? 'present' : 'missing', execution: 'external-unverified',
        deployment: installed ? { id: revision, revision: 'b'.repeat(64), skillIds: [skill.id], canRollback: true, actor: 'fixture-owner', updatedAt: new Date().toISOString() } : null,
        skills: [{ skillId: skill.id, state: installed ? 'current' : 'missing', installedVersion: installed ? '1.0.0' : null, expectedVersion: '1.0.0' }] } : null } } });
  });
  await page.route('**/api/skills/installations', route => {
    mutations.push(route.request().postDataJSON());
    if (installed) return route.fulfill({ status: 409, json: { success: false, error: '项目技能版本已变更，请重新核验。' } });
    installed = true; return route.fulfill({ json: { success: true, data: { id: revision } } });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/skills');
  await page.getByLabel('项目安装状态', { exact: true }).selectOption('fixture-project');
  await page.getByLabel('安装到 Agent').selectOption('codex');
  await page.getByRole('button', { name: '查看 安装流程测试技能' }).click();
  await page.getByLabel('安装版本').selectOption('1.0.0');
  await page.getByRole('button', { name: '安装并固定版本' }).click();
  await expect(page.getByRole('button', { name: '卸载', exact: true })).toBeEnabled();
  expect(mutations[0]).toMatchObject({ projectId: 'fixture-project', target: 'codex', action: 'install', version: '1.0.0', expectedRevision: null });
  await page.getByRole('button', { name: '卸载', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '项目技能版本已变更' })).toBeVisible();
  expect(mutations[1]).toMatchObject({ action: 'uninstall', expectedRevision: revision });
  await expect(page.getByRole('dialog')).toContainText('实际运行效果尚未验证');
});
