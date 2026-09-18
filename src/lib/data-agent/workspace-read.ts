import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Read a bounded artifact without following workspace symlinks or special files. */
export async function readWorkspaceFileBounded(
  workspaceRoot: string,
  relativePath: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<{ content: Buffer; sha256: string; bytes: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new Error('Invalid workspace artifact byte limit.');
  }
  const parts = relativePath.split('/');
  if (path.isAbsolute(relativePath) || /[\\\0]/.test(relativePath)
    || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe workspace artifact path.');
  }
  const root = path.resolve(workspaceRoot);
  let current = root;
  for (const [index, part] of ['', ...parts].entries()) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Workspace evidence must use regular files within real directories.');
    }
  }
  const handle = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Workspace evidence exceeds its file contract.');
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(current);
    const relative = path.relative(realRoot, realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workspace evidence escaped its root.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('Workspace evidence exceeds its byte limit.');
    const bytes = buffer.subarray(0, length);
    return {
      content: bytes,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes: length,
    };
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceJsonBounded(workspaceRoot: string, relativePath: string, maxBytes?: number) {
  const { content, ...identity } = await readWorkspaceFileBounded(workspaceRoot, relativePath, maxBytes);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  return { ...identity, value: JSON.parse(text) as unknown };
}
