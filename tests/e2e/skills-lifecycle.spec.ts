import { expect, test } from 'playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/projects', route => route.fulfill({ json: { success: true, data: [] } }));
});

test('real Studio draft, publish and full rollback keep the catalog consistent', async ({ page, request, isMobile }) => {
  test.setTimeout(120_000);
  const skillId = 'image-extraction';
  const initial = await (await request.get('/api/skills')).json();
  const initialVersion = initial.data.skills.find((skill: { id: string }) => skill.id === skillId).version;
  const version = `0.5.${Date.now()}`;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? 'references/browser-draft-folder' : undefined));
  await page.goto(`/skills?view=studio&skill=${skillId}`);
  const editor = page.getByLabel('Skill 源码编辑器');
  await expect(editor).toHaveValue(/name: image-extraction/);
  const original = await editor.inputValue();
  const draftText = `${original}\n<!-- browser lifecycle ${version} -->\n`;
  await editor.fill(draftText);
  if (!isMobile) {
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
    await expect(page.getByText('文件夹已创建。', { exact: true })).toBeVisible();
    await expect(editor).toHaveValue(draftText);
  }
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('草稿已保存', { exact: true })).toBeAttached();
  const duringDraft = await (await request.get('/api/skills')).json();
  expect(duringDraft.data.skills.find((skill: { id: string }) => skill.id === skillId)).toMatchObject({ version: initialVersion, health: { status: 'ok' } });
  await page.getByRole('button', { name: '版本管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '技能版本管理' });
  await dialog.getByLabel('版本号', { exact: true }).fill(version);
  await dialog.getByLabel('发布摘要').fill('隔离浏览器生命周期回归');
  await dialog.getByLabel('变更点').fill('验证草稿、发布和完整回退');
  await dialog.getByRole('button', { name: '生成发布前 Diff' }).click();
  await expect(dialog.getByRole('button', { name: '确认 Diff 后发布' })).toBeEnabled();
  const publish = page.waitForResponse(response => response.url().endsWith('/api/skills') && response.request().postDataJSON()?.action === 'publish-version');
  await dialog.getByRole('button', { name: '确认 Diff 后发布' }).click();
  expect((await publish).status()).toBe(200);
  await expect(dialog.getByText('当前没有未发布草稿')).toBeVisible();
  const released = await (await request.get('/api/skills')).json();
  expect(released.data.skills.find((skill: { id: string }) => skill.id === skillId)).toMatchObject({ version, health: { status: 'ok' } });
  const row = dialog.locator('tbody tr').filter({ hasText: `v${initialVersion}` });
  await expect(row.getByRole('button', { name: '回滚', exact: true })).toBeEnabled();
  const rollback = page.waitForResponse(response => response.url().endsWith('/api/skills') && response.request().postDataJSON()?.action === 'rollback-version');
  await row.getByRole('button', { name: '回滚', exact: true }).click();
  expect((await rollback).status()).toBe(200);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(editor).toHaveValue(original);
  const restored = await (await request.get('/api/skills')).json();
  expect(restored.data.skills.find((skill: { id: string }) => skill.id === skillId)).toMatchObject({ version: initialVersion, health: { status: 'ok' } });
  expect(errors).toEqual([]);
});

test('a stale browser editor retains its unsaved text after a conflict', async ({ page, request }) => {
  page.on('dialog', dialog => dialog.accept());
  const skillId = 'image-extraction';
  await page.goto(`/skills?view=studio&skill=${skillId}`);
  const editor = page.getByLabel('Skill 源码编辑器');
  await expect(editor).toHaveValue(/name: image-extraction/);
  const original = await editor.inputValue();
  const loaded = await (await request.post('/api/skills', { data: { action: 'read-file', skillId, filePath: 'SKILL.md' } })).json();
  const competing = await request.post('/api/skills', { data: { action: 'save-file', skillId, content: `${original}\n<!-- second editor -->\n`, expectedRevision: loaded.data.revision } });
  expect(competing.status()).toBe(200);
  const competingSource = (await competing.json()).data;
  const ownDraft = `${original}\n<!-- first editor still owns this text -->\n`;
  await editor.fill(ownDraft);
  const conflict = page.waitForResponse(response => response.status() === 409 && response.url().endsWith('/api/skills'));
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await conflict;
  await expect(editor).toHaveValue(ownDraft);
  const discard = await request.post('/api/skills', { data: { action: 'discard-draft', skillId, expectedRevision: competingSource.revision } });
  expect(discard.status()).toBe(200);
});
