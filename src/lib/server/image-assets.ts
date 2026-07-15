import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_CONFIGURABLE_IMAGE_BYTES = 50 * 1024 * 1024;

export interface DetectedImageType {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  extension: '.png' | '.jpg' | '.webp' | '.gif';
}

export const SUPPORTED_IMAGE_MIME_TYPES = new Set<DetectedImageType['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export class ImageAssetError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ImageAssetError';
    this.status = status;
  }
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

export function detectImageType(bytes: Uint8Array): DetectedImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (bytes.length >= 12 && asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (bytes.length >= 6 && (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a'))) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  return null;
}

export function configuredMaxImageBytes(value = process.env.QUANTPILOT_MAX_IMAGE_UPLOAD_BYTES): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_IMAGE_UPLOAD_BYTES;
  }
  return Math.min(Math.floor(parsed), MAX_CONFIGURABLE_IMAGE_BYTES);
}

export function validateImageBytes(
  bytes: Uint8Array,
  options: { declaredMimeType?: string; maxBytes?: number } = {},
): DetectedImageType {
  const maxBytes = options.maxBytes ?? configuredMaxImageBytes();
  if (bytes.byteLength === 0) {
    throw new ImageAssetError('Image cannot be empty');
  }
  if (bytes.byteLength > maxBytes) {
    throw new ImageAssetError(`Image must be smaller than ${Math.floor(maxBytes / 1024 / 1024)}MB`, 413);
  }

  const detected = detectImageType(bytes);
  if (!detected) {
    throw new ImageAssetError('File content must be a PNG, JPEG, WebP, or GIF image');
  }
  if (options.declaredMimeType && options.declaredMimeType !== detected.mimeType) {
    throw new ImageAssetError('File content does not match the declared image type');
  }
  return detected;
}

export function decodeBase64Image(
  input: string,
  options: { requiredMimeType?: DetectedImageType['mimeType']; maxBytes?: number } = {},
): Buffer {
  const match = input.trim().match(/^data:([^;,]+);base64,(.*)$/s);
  const declaredMimeType = match?.[1];
  const rawPayload = (match?.[2] ?? input).replace(/\s/g, '');
  if (!rawPayload || !/^[a-z\d+/]*={0,2}$/i.test(rawPayload) || rawPayload.length % 4 === 1) {
    throw new ImageAssetError('Image payload must be valid base64');
  }

  const maxBytes = options.maxBytes ?? configuredMaxImageBytes();
  const estimatedBytes = Math.floor((rawPayload.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    throw new ImageAssetError(`Image must be smaller than ${Math.floor(maxBytes / 1024 / 1024)}MB`, 413);
  }

  const paddedPayload = rawPayload.padEnd(Math.ceil(rawPayload.length / 4) * 4, '=');
  const buffer = Buffer.from(paddedPayload, 'base64');
  const canonicalInput = rawPayload.replace(/=+$/, '');
  if (buffer.toString('base64').replace(/=+$/, '') !== canonicalInput) {
    throw new ImageAssetError('Image payload must be valid base64');
  }

  const detected = validateImageBytes(buffer, {
    declaredMimeType,
    maxBytes,
  });
  if (options.requiredMimeType && detected.mimeType !== options.requiredMimeType) {
    throw new ImageAssetError(`Image content must be ${options.requiredMimeType}`);
  }
  return buffer;
}

function assertSafeSegment(value: string, label: string, allowDot = false): void {
  const pattern = allowDot ? /^[a-z\d][a-z\d._-]{0,191}$/i : /^[a-z\d][a-z\d_-]{0,159}$/i;
  if (!pattern.test(value) || value === '.' || value === '..') {
    throw new ImageAssetError(`Invalid ${label}`);
  }
}

function assertContained(base: string, target: string): string {
  const normalizedBase = path.resolve(base);
  const normalizedTarget = path.resolve(target);
  if (normalizedTarget !== normalizedBase && !normalizedTarget.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new ImageAssetError('Path traversal not allowed');
  }
  return normalizedTarget;
}

export function resolveProjectAssetsPath(projectId: string): string {
  assertSafeSegment(projectId, 'project id');
  const configuredRoot = process.env.PROJECTS_DIR || './data/projects';
  const projectsRoot = path.isAbsolute(configuredRoot)
    ? path.resolve(configuredRoot)
    : path.resolve(process.cwd(), configuredRoot);
  return assertContained(projectsRoot, path.join(projectsRoot, projectId, 'assets'));
}

export function resolveProjectAssetPath(projectId: string, filename: string): string {
  assertSafeSegment(filename, 'asset filename', true);
  const assetsRoot = resolveProjectAssetsPath(projectId);
  return assertContained(assetsRoot, path.join(assetsRoot, filename));
}

/**
 * Resolve an already-uploaded image without trusting a client supplied host path.
 * Absolute paths are accepted only as a temporary compatibility shape and must
 * exactly identify the same file below this project's dedicated assets folder.
 */
export async function resolveExistingProjectAssetPath(
  projectId: string,
  inputPath: string,
): Promise<{ absolutePath: string; relativePath: string; filename: string; size: number }> {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.length > 2_048) {
    throw new ImageAssetError('Invalid asset path');
  }
  if (inputPath.includes('\0') || /[\r\n]/.test(inputPath)) {
    throw new ImageAssetError('Invalid asset path');
  }

  const normalizedInput = inputPath.replaceAll('\\', '/').replace(/^\.\//, '');
  const relativePath = path.isAbsolute(inputPath)
    ? null
    : normalizedInput.startsWith('assets/')
      ? normalizedInput
      : normalizedInput.includes('/')
        ? null
        : `assets/${normalizedInput}`;
  const filename = path.basename(inputPath);
  assertSafeSegment(filename, 'asset filename', true);
  if (relativePath !== null && relativePath !== `assets/${filename}`) {
    throw new ImageAssetError('Asset path must identify a file directly inside this project assets folder');
  }

  const assetsRoot = resolveProjectAssetsPath(projectId);
  const expectedPath = resolveProjectAssetPath(projectId, filename);
  if (path.isAbsolute(inputPath) && path.resolve(inputPath) !== expectedPath) {
    throw new ImageAssetError('Asset path is outside this project');
  }

  const rootStat = await fs.lstat(assetsRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ImageAssetError('Project assets folder is unavailable');
  }
  const targetStat = await fs.lstat(expectedPath).catch(() => null);
  if (!targetStat?.isFile() || targetStat.isSymbolicLink()) {
    throw new ImageAssetError('Image asset not found', 404);
  }

  const [canonicalRoot, canonicalTarget] = await Promise.all([
    fs.realpath(assetsRoot),
    fs.realpath(expectedPath),
  ]);
  assertContained(canonicalRoot, canonicalTarget);
  return {
    absolutePath: canonicalTarget,
    relativePath: `assets/${filename}`,
    filename,
    size: targetStat.size,
  };
}
