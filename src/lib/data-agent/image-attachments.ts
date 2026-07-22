import fs from 'node:fs/promises';
import path from 'node:path';

import {
  configuredMaxImageBytes,
  ImageAssetError,
  resolveExistingProjectAssetPath,
  validateImageBytes,
} from '@/lib/server/image-assets';

import {
  DATA_AGENT_ATTACHMENTS_RELATIVE_PATH,
  DATA_AGENT_ROOT_RELATIVE_PATH,
} from './workspace-layout';

export const MAX_DATA_AGENT_IMAGE_ATTACHMENTS = 8;

const MAX_IMAGE_BYTES = configuredMaxImageBytes();

export const MAX_DATA_AGENT_TOTAL_IMAGE_BYTES = Math.min(
  25 * 1024 * 1024,
  MAX_DATA_AGENT_IMAGE_ATTACHMENTS * MAX_IMAGE_BYTES,
);

export type DataAgentImageAttachmentInput = {
  name?: string;
  path: string;
  mimeType?: string;
};

export type ProcessedDataAgentImageAttachment = {
  name: string;
  path: string;
  url: string;
  publicUrl: string;
  mimeType: string;
  size: number;
};

function isPathInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function mirrorAssetToProjectPublic(
  projectRoot: string,
  filename: string,
  sourcePath: string,
): Promise<string> {
  const [canonicalProjectRoot, canonicalAssetsRoot] = await Promise.all([
    fs.realpath(/* turbopackIgnore: true */ projectRoot),
    fs.realpath(path.dirname(/* turbopackIgnore: true */ sourcePath)),
  ]);
  if (!isPathInside(canonicalProjectRoot, canonicalAssetsRoot)) {
    throw new ImageAssetError('Project attachment storage is outside the project workspace');
  }
  const uploadsDir = path.join(
    /* turbopackIgnore: true */ canonicalProjectRoot,
    'public',
    'uploads',
  );
  await fs.mkdir(/* turbopackIgnore: true */ uploadsDir, { recursive: true });
  const destinationPath = path.join(
    /* turbopackIgnore: true */ uploadsDir,
    filename,
  );
  await fs.copyFile(
    /* turbopackIgnore: true */ sourcePath,
    /* turbopackIgnore: true */ destinationPath,
  );
  return `/uploads/${filename}`;
}

export async function normalizeDataAgentImageAttachment(params: {
  projectId: string;
  projectRoot: string;
  attachment: DataAgentImageAttachmentInput;
  index: number;
}): Promise<ProcessedDataAgentImageAttachment> {
  const asset = await resolveExistingProjectAssetPath(params.projectId, params.attachment.path);
  if (asset.size > MAX_IMAGE_BYTES) {
    throw new ImageAssetError(
      `Image must be smaller than ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB`,
      413,
    );
  }
  const bytes = await fs.readFile(/* turbopackIgnore: true */ asset.absolutePath);
  const detected = validateImageBytes(bytes, {
    ...(params.attachment.mimeType
      ? { declaredMimeType: params.attachment.mimeType }
      : {}),
    maxBytes: MAX_IMAGE_BYTES,
  });
  const publicUrl = await mirrorAssetToProjectPublic(
    params.projectRoot,
    asset.filename,
    asset.absolutePath,
  );
  return {
    name: params.attachment.name ?? `Image ${params.index + 1}`,
    path: asset.relativePath,
    url: `/api/assets/${params.projectId}/${asset.filename}`,
    publicUrl,
    mimeType: detected.mimeType,
    size: bytes.byteLength,
  };
}

export async function writeDataAgentAttachmentManifest(params: {
  projectRoot: string;
  projectId: string;
  requestId: string;
  images: ProcessedDataAgentImageAttachment[];
  instruction: string;
  extension?: Record<string, unknown>;
}): Promise<string | null> {
  if (params.images.length === 0) return null;

  const controlDirectory = path.join(
    /* turbopackIgnore: true */ params.projectRoot,
    DATA_AGENT_ROOT_RELATIVE_PATH,
  );
  const absolutePath = path.join(
    /* turbopackIgnore: true */ params.projectRoot,
    DATA_AGENT_ATTACHMENTS_RELATIVE_PATH,
  );
  const payload = {
    ...(params.extension ?? {}),
    schemaVersion: 1,
    projectId: params.projectId,
    requestId: params.requestId,
    createdAt: new Date().toISOString(),
    instruction: params.instruction,
    attachments: params.images.map((image, index) => ({
      id: `image-${index + 1}`,
      name: image.name,
      path: image.path,
      url: image.url,
      publicUrl: image.publicUrl,
      mimeType: image.mimeType,
      size: image.size,
    })),
  };

  await fs.mkdir(/* turbopackIgnore: true */ controlDirectory, { recursive: true });
  await fs.writeFile(
    /* turbopackIgnore: true */ absolutePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  return DATA_AGENT_ATTACHMENTS_RELATIVE_PATH;
}
