import { describe, expect, it } from 'vitest';
import {
  ImageAssetError,
  configuredMaxImageBytes,
  decodeBase64Image,
  detectImageType,
  resolveProjectAssetPath,
  validateImageBytes,
} from './image-assets';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

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
});
