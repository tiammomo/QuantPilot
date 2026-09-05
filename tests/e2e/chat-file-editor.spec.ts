import { expect, test, type Page } from 'playwright/test';

// Exercise the real workspace UI against an in-memory repository. No model,
// business project, file write or generation request reaches the test server.
async function openWorkspace(page: Page, mobile: boolean) {
  const files = new Map([['a.ts', 'export const a = 1;'], ['b.ts', 'export const b = 2;']]);
  const writes: Array<{ path: string; content: string }> = [];
  const unexpected: string[] = [];
  let failSave = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let json: unknown = {};
    if (path === '/api/projects/editor-fixture') {
      json = { id: 'editor-fixture', name: '文件编辑回归', status: 'active', preferredCli: 'pi' };
    } else if (path.endsWith('/tree')) {
      json = [...files.keys()].map((file) => ({ path: file, type: 'file' }));
    } else if (path.endsWith('/file') && request.method() === 'GET') {
      json = { content: files.get(url.searchParams.get('path')!) };
    } else if (path.endsWith('/file') && request.method() === 'PUT') {
      const write = request.postDataJSON() as { path: string; content: string };
      writes.push(write);
      if (failSave) {
        await route.fulfill({ status: 403, json: { error: '测试：文件只读' } });
        return;
      }
      files.set(write.path, write.content);
      json = { success: true };
    } else if (path.endsWith('/services')) {
      json = [];
    } else if (path.endsWith('/deployment/current')) {
      json = { has_deployment: false };
    } else if (path.endsWith('/requests/active')) {
      json = { hasActiveRequests: false, activeCount: 0 };
    } else if (path.endsWith('/agent/approvals')) {
      json = { success: true, data: [] };
    } else if (path.endsWith('/messages')) {
      json = { messages: [], pagination: { hasMore: false }, totalCount: 0 };
    } else if (path.endsWith('/stream')) {
      await route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      return;
    } else if (path.endsWith('/generation/status') || path.endsWith('/quant/validation')) {
      json = { success: true, data: null };
    } else if (path === '/api/settings/global') {
      json = { default_cli: 'pi' };
    } else {
      unexpected.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 404, json: { error: 'Unconfigured browser fixture' } });
      return;
    }
    await route.fulfill({ json });
  });
  await page.goto('/editor-fixture/chat?visualCheck=1');
  if (mobile) {
    await page.getByRole('navigation', { name: '移动端工作区视图' }).getByRole('button', { name: '文件', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '显示项目文件', exact: true }).click();
  }
  await page.getByRole('button', { name: 'a.ts', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Code editor' })).toHaveValue(files.get('a.ts')!);
  return { files, writes, unexpected, setFailSave: (value: boolean) => { failSave = value; } };
}

test('saves the selected file and protects a draft when closing is cancelled', async ({ page, isMobile }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const repo = await openWorkspace(page, isMobile);
  const editor = page.getByRole('textbox', { name: 'Code editor' });
  await editor.fill('export const a = 3;');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(repo.writes).toEqual([{ path: 'a.ts', content: 'export const a = 3;' }]);
  await page.getByRole('button', { name: 'b.ts', exact: true }).click();
  await expect(editor).toHaveValue('export const b = 2;');
  await editor.fill('export const b = 4;');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '关闭当前文件' }).click();
  await expect(editor).toHaveValue('export const b = 4;');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  if (isMobile) {
    const bounds = await editor.boundingBox();
    expect(bounds!.width).toBeGreaterThan(page.viewportSize()!.width * 0.75);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('file-editor-draft.png') });
  expect(repo.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test('a failed save retains the draft and can be retried', async ({ page, isMobile }) => {
  const repo = await openWorkspace(page, isMobile);
  repo.setFailSave(true);
  const editor = page.getByRole('textbox', { name: 'Code editor' });
  await editor.fill('export const a = 5;');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Save error', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('export const a = 5;');
  expect(repo.files.get('a.ts')).toBe('export const a = 1;');
  repo.setFailSave(false);
  await editor.press('Control+s');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(repo.files.get('a.ts')).toBe('export const a = 5;');
  expect(repo.unexpected).toEqual([]);
});
