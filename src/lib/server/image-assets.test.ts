import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ImageAssetError,
  configuredMaxImageBytes,
  decodeBase64Image,
  detectImageType,
  resolveProjectAssetPath,
  resolveExistingProjectAssetPath,
  validateImageBytes,
} from './image-assets';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PROJECTS_DIR;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('image asset validation', () => {
  it('detects supported image signatures instead of trusting filenames', () => {
    expect(detectImageType(PNG_BYTES)).toEqual({ mimeType: 'image/png', extension: '.png' });
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))?.mimeType).toBe('image/jpeg');
    expect(detectImageType(Buffer.from('GIF89a', 'ascii'))?.mimeType).toBe('image/gif');
    expect(detectImageType(Buffer.from('not-an-image'))).toBeNull();
  });

  it('rejects MIME spoofing and oversized content', () => {
    expect(() => validateImageBytes(PNG_BYTES, { declaredMimeType: 'image/jpeg' })).toThrow(ImageAssetError);
    expect(() => validateImageBytes(PNG_BYTES, { maxBytes: 4 })).toThrow(/smaller/);
  });

  it('decodes validated base64 PNG payloads', () => {
    const value = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    expect(decodeBase64Image(value, { requiredMimeType: 'image/png' })).toEqual(PNG_BYTES);
    expect(() => decodeBase64Image('not-base64!')).toThrow(/valid base64/);
  });

  it('bounds configuration and rejects traversal filenames', () => {
    expect(configuredMaxImageBytes('invalid')).toBe(10 * 1024 * 1024);
    expect(configuredMaxImageBytes(String(100 * 1024 * 1024))).toBe(50 * 1024 * 1024);
    expect(() => resolveProjectAssetPath('project-safe', '../secret.png')).toThrow(/Invalid asset filename/);
    expect(resolveProjectAssetPath('project-safe', 'logo.png')).toContain('project-safe/assets/logo.png');
  });

  it('accepts only regular files from the current project assets directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-images-'));
    temporaryDirectories.push(root);
    process.env.PROJECTS_DIR = root;
    const assets = path.join(root, 'project-safe', 'assets');
    await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(assets, 'safe.png'), PNG_BYTES);
    const outside = path.join(root, 'secret.png');
    await fs.writeFile(outside, PNG_BYTES);

    await expect(resolveExistingProjectAssetPath('project-safe', 'assets/safe.png')).resolves.toMatchObject({
      relativePath: 'assets/safe.png',
      filename: 'safe.png',
    });
    await expect(resolveExistingProjectAssetPath('project-safe', outside)).rejects.toThrow(/project-relative/);
    await expect(resolveExistingProjectAssetPath('project-safe', 'safe.png')).rejects.toThrow(/directly inside/);
    await fs.symlink(outside, path.join(assets, 'link.png'));
    await expect(resolveExistingProjectAssetPath('project-safe', 'assets/link.png')).rejects.toThrow(/not found/);
  });
});
