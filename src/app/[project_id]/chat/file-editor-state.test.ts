import { describe, expect, it, vi } from 'vitest';
import { ProjectFileEditor } from './file-editor-state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('project file editor request ordering', () => {
  it('keeps the latest selected file when an aborted read completes late', async () => {
    const oldRead = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(Response.json({ content: 'file B' }));
    const editor = new ProjectFileEditor('project', '', fetcher);
    const openingA = editor.open('a.ts');
    await editor.open('b.ts');
    oldRead.resolve(Response.json({ content: 'file A' }));
    await openingA;
    expect(editor.getSnapshot()).toMatchObject({ selectedFile: 'b.ts', editedContent: 'file B' });
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('preserves edits made while a background refresh is in flight', async () => {
    const refresh = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ content: 'original' }))
      .mockReturnValueOnce(refresh.promise);
    const editor = new ProjectFileEditor('project', '', fetcher);
    await editor.open('a.ts');
    const reloading = editor.reload();
    editor.edit('unsaved draft');
    refresh.resolve(Response.json({ content: 'server update' }));
    await reloading;
    expect(editor.getSnapshot()).toMatchObject({
      content: 'original', editedContent: 'unsaved draft', hasUnsavedChanges: true,
    });
  });

  it('does not let a completed save reset a different file', async () => {
    const save = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ content: 'A' }))
      .mockReturnValueOnce(save.promise)
      .mockResolvedValueOnce(Response.json({ content: 'B' }));
    const editor = new ProjectFileEditor('project', '', fetcher);
    await editor.open('a.ts');
    editor.edit('saved A');
    const saving = editor.save();
    await editor.open('b.ts');
    editor.edit('draft B');
    save.resolve(Response.json({ success: true }));
    expect(await saving).toBe(false);
    expect(editor.getSnapshot()).toMatchObject({
      selectedFile: 'b.ts', content: 'B', editedContent: 'draft B',
      hasUnsavedChanges: true, saveFeedback: 'idle',
    });
  });

  it('keeps later typing dirty and prevents duplicate saves', async () => {
    const save = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ content: 'original' }))
      .mockReturnValueOnce(save.promise);
    const editor = new ProjectFileEditor('project', '', fetcher);
    await editor.open('a.ts');
    editor.edit('submitted');
    const saving = editor.save();
    expect(await editor.save()).toBe(false);
    editor.edit('newer draft');
    save.resolve(Response.json({ success: true }));
    expect(await saving).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      path: 'a.ts', content: 'submitted',
    });
    expect(editor.getSnapshot()).toMatchObject({
      content: 'submitted', editedContent: 'newer draft', hasUnsavedChanges: true, isSavingFile: false,
    });
  });

  it('never turns a failed read into editable fallback file content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 403 }));
    const editor = new ProjectFileEditor('project', '', fetcher);
    await editor.open('private.ts');
    editor.edit('accidental overwrite');
    expect(await editor.save()).toBe(false);
    expect(editor.getSnapshot()).toMatchObject({
      content: '', editedContent: '', hasUnsavedChanges: false, fileLoadError: '文件加载失败（HTTP 403）',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves the draft and surfaces a failed save', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ content: 'original' }))
      .mockResolvedValueOnce(Response.json({ error: 'Write denied' }, { status: 403 }));
    const editor = new ProjectFileEditor('project', '', fetcher);
    await editor.open('a.ts');
    editor.edit('draft');
    expect(await editor.save()).toBe(false);
    expect(editor.getSnapshot()).toMatchObject({
      content: 'original', editedContent: 'draft', hasUnsavedChanges: true,
      saveError: 'Write denied', saveFeedback: 'error', isSavingFile: false,
    });
  });
});
