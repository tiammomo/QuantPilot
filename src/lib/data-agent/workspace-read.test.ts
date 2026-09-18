import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkspaceJsonBounded } from './workspace-read';

describe('bounded workspace evidence reads', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-evidence-read-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  it('binds complete UTF-8 JSON to its byte hash', async () => {
    await fs.writeFile(path.join(root, 'data.json'), '{"name":"行情","value":"1.00000000000000001"}');
    expect(await readWorkspaceJsonBounded(root, 'data.json')).toMatchObject({
      value: { name: '行情', value: '1.00000000000000001' }, sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });
  it('rejects oversized and invalid JSON', async () => {
    await fs.writeFile(path.join(root, 'data.json'), JSON.stringify({ data: 'a'.repeat(100) }));
    await expect(readWorkspaceJsonBounded(root, 'data.json', 50)).rejects.toThrow(/contract|limit/);
    await fs.writeFile(path.join(root, 'data.json'), 'not JSON');
    await expect(readWorkspaceJsonBounded(root, 'data.json')).rejects.toThrow();
  });
  it.each(['../outside.json', '/tmp/outside.json', 'a/../b.json', 'a\\b.json', './data.json'])(
    'rejects traversal before opening %s', async file => {
      await expect(readWorkspaceJsonBounded(root, file)).rejects.toThrow('Unsafe');
    }
  );
  it('rejects file, directory and root symlinks', async () => {
    await fs.mkdir(path.join(root, 'real'));
    await fs.writeFile(path.join(root, 'real', 'data.json'), '{}');
    await fs.symlink(path.join(root, 'real', 'data.json'), path.join(root, 'file.json'));
    await fs.symlink(path.join(root, 'real'), path.join(root, 'linked'));
    await expect(readWorkspaceJsonBounded(root, 'file.json')).rejects.toThrow('regular files');
    await expect(readWorkspaceJsonBounded(root, 'linked/data.json')).rejects.toThrow('regular files');
    await expect(readWorkspaceJsonBounded(path.join(root, 'linked'), 'data.json')).rejects.toThrow('regular files');
  });
});
