import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MoAgentTool } from '@/lib/agent/types';
import { MoAgentToolError, throwIfAborted } from './errors';
import { inputRecord, optionalString } from './input';
import { MoAgentWorkspacePolicy } from './path-policy';
import {
  DEFAULT_TOOL_OUTPUT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  executeMoAgentTool,
} from './runtime';

export const PORTFOLIO_SCREENSHOT_FIELDS = [
  'account_total_asset',
  'cash_available',
  'market_value',
  'daily_pnl',
  'total_pnl',
  'position_ratio',
  'holdings[].name',
  'holdings[].symbol_if_visible_or_resolved',
  'holdings[].quantity',
  'holdings[].cost_price',
  'holdings[].current_price',
  'holdings[].market_value',
  'holdings[].pnl',
  'holdings[].pnl_percent',
] as const;

const DEFAULT_ATTACHMENT_CONTEXT = '.quantpilot/attachments.json';
const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENT_CONTEXT_BYTES = 1024 * 1024;

export interface ImageExtractionInput {
  attachmentContextPath?: string;
  imagePath?: string;
  prompt?: string;
}

export interface MoAgentImageExtractionToolOptions {
  workspaceRoot: string;
  timeoutMs?: number;
  maxImageBytes?: number;
  maxAttachments?: number;
  maxOutputChars?: number;
  now?: () => Date;
}

interface AttachmentRecord {
  id?: string;
  name?: string;
  absolutePath?: string;
  path?: string;
  url?: string;
  publicUrl?: string | null;
  mimeType?: string | null;
  size?: number | null;
}

export interface InspectedImage {
  id: string;
  name: string;
  path: string;
  url: string | null;
  publicUrl: string | null;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  sha256: string;
}

export interface NoAttachmentsPayload {
  schemaVersion: 1;
  runtime: 'MoAgent';
  tool: 'image-extraction';
  status: 'no_attachments';
  message: string;
}

export interface ImageMetadataPayload {
  schemaVersion: 1;
  runtime: 'MoAgent';
  tool: 'image-extraction';
  status: 'metadata_ready';
  createdAt: string;
  attachmentContextPath: string;
  prompt: string | null;
  images: InspectedImage[];
  visualRecognition: {
    status: 'manual_confirmation_required';
    reason: string;
    fallbackRule: string;
  };
  imageExtraction: {
    source: 'uploaded_image';
    extractedFields: {
      account_total_asset: null;
      cash_available: null;
      market_value: null;
      daily_pnl: null;
      total_pnl: null;
      position_ratio: null;
      holdings: [];
    };
    needs_manual_confirmation: true;
    manual_confirmation_fields: readonly string[];
  };
  dashboardContract: {
    requiredFinalDataFields: string[];
    evidenceFiles: string[];
  };
}

export type ImageExtractionPayload = NoAttachmentsPayload | ImageMetadataPayload;

function parseImageExtractionInput(value: unknown): ImageExtractionInput {
  const record = inputRecord(value);
  const allowed = new Set(['attachmentContextPath', 'imagePath', 'prompt']);
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey) {
    throw new MoAgentToolError('INVALID_TOOL_INPUT', `Unknown image-extraction input field: ${unknownKey}.`);
  }
  const attachmentContextPath = record.attachmentContextPath === undefined
    ? undefined
    : optionalString(record, 'attachmentContextPath', '', { maxLength: 2_048 });
  const imagePath = record.imagePath === undefined
    ? undefined
    : optionalString(record, 'imagePath', '', { maxLength: 2_048 });
  const prompt = record.prompt === undefined
    ? undefined
    : optionalString(record, 'prompt', '', { allowEmpty: true, maxLength: 2_000 });
  return {
    ...(attachmentContextPath === undefined ? {} : { attachmentContextPath }),
    ...(imagePath === undefined ? {} : { imagePath }),
    ...(prompt === undefined ? {} : { prompt }),
  };
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function inferMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return null;
}

function readImageSize(buffer: Buffer, mimeType: string): { width: number | null; height: number | null } {
  if (mimeType === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === 'image/jpeg' && buffer.length > 4) {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;
      const isSof = [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
      ].includes(marker);
      if (isSof && segmentLength >= 7) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + segmentLength;
    }
  }
  if (mimeType === 'image/webp' && buffer.length >= 30) {
    const chunk = buffer.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') {
      return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return { width: null, height: null };
}

function pathForPolicy(
  workspaceRoot: string,
  inputPath: string,
  options: { allowPlatformAbsolutePath?: boolean } = {},
): string {
  if (inputPath.length > 2_048) {
    throw new MoAgentToolError('INVALID_PATH', 'Image paths cannot exceed 2048 characters.');
  }
  if (inputPath.includes('\0') || /[\r\n]/.test(inputPath)) {
    throw new MoAgentToolError('INVALID_PATH', 'Image paths cannot contain control characters.');
  }
  if (!path.isAbsolute(inputPath) && !path.win32.isAbsolute(inputPath)) return inputPath;
  if (!options.allowPlatformAbsolutePath) {
    throw new MoAgentToolError(
      'ABSOLUTE_PATH_DENIED',
      'MoAgent image tool inputs must use workspace-relative paths.',
    );
  }
  const relative = path.relative(workspaceRoot, path.resolve(inputPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MoAgentToolError(
      'PATH_TRAVERSAL_DENIED',
      `Image path must be a file below the MoAgent workspace: ${inputPath}.`,
    );
  }
  return relative.replaceAll(path.sep, '/');
}

async function readAttachmentContext(
  policy: MoAgentWorkspacePolicy,
  contextPath: string,
): Promise<{ contextPath: string; attachments: AttachmentRecord[] }> {
  const resolved = await policy.resolveReadPath(pathForPolicy(policy.workspaceRoot, contextPath));
  const stat = await fs.stat(resolved.canonicalPath);
  if (!stat.isFile()) throw new MoAgentToolError('NOT_A_FILE', `Attachment context is not a file: ${contextPath}.`);
  if (stat.size > MAX_ATTACHMENT_CONTEXT_BYTES) {
    throw new MoAgentToolError(
      'ATTACHMENT_CONTEXT_TOO_LARGE',
      `Attachment context exceeds ${MAX_ATTACHMENT_CONTEXT_BYTES} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(resolved.canonicalPath, 'utf8')) as unknown;
  } catch (error) {
    throw new MoAgentToolError(
      'INVALID_ATTACHMENT_CONTEXT',
      `Attachment context is not valid JSON: ${contextPath}.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MoAgentToolError('INVALID_ATTACHMENT_CONTEXT', 'Attachment context must be a JSON object.');
  }
  const attachments = (parsed as { attachments?: unknown }).attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    throw new MoAgentToolError('INVALID_ATTACHMENT_CONTEXT', 'attachments must be an array.');
  }
  if ((attachments ?? []).some(
    (attachment) => !attachment || typeof attachment !== 'object' || Array.isArray(attachment),
  )) {
    throw new MoAgentToolError(
      'INVALID_ATTACHMENT_CONTEXT',
      'Every attachments entry must be a JSON object.',
    );
  }
  return {
    contextPath: resolved.canonicalRelativePath,
    attachments: (attachments ?? []) as AttachmentRecord[],
  };
}

async function inspectImage(params: {
  policy: MoAgentWorkspacePolicy;
  attachment: AttachmentRecord;
  index: number;
  maxImageBytes: number;
  signal: AbortSignal;
}): Promise<InspectedImage> {
  throwIfAborted(params.signal);
  const sourcePath = params.attachment.absolutePath ?? params.attachment.path;
  if (typeof sourcePath !== 'string' || !sourcePath) {
    throw new MoAgentToolError(
      'INVALID_ATTACHMENT',
      `Attachment ${params.attachment.name ?? params.index + 1} is missing path/absolutePath.`,
    );
  }
  // Platform-owned attachment manifests historically persisted absolutePath. Convert it
  // internally for compatibility, then expose only the canonical workspace-relative path.
  const requestedPath = pathForPolicy(params.policy.workspaceRoot, sourcePath, {
    allowPlatformAbsolutePath: params.attachment.absolutePath === sourcePath,
  });
  const resolved = await params.policy.resolveReadPath(requestedPath);
  const stat = await fs.stat(resolved.canonicalPath);
  if (!stat.isFile()) throw new MoAgentToolError('NOT_A_FILE', `Image attachment is not a file: ${sourcePath}.`);
  if (stat.size > params.maxImageBytes) {
    throw new MoAgentToolError(
      'IMAGE_TOO_LARGE',
      `Image ${params.attachment.name ?? resolved.relativePath} exceeds ${params.maxImageBytes} bytes.`,
      { size: stat.size, maxImageBytes: params.maxImageBytes },
    );
  }
  const buffer = await fs.readFile(resolved.canonicalPath);
  if (buffer.length > params.maxImageBytes) {
    throw new MoAgentToolError(
      'IMAGE_TOO_LARGE',
      `Image ${params.attachment.name ?? resolved.relativePath} exceeds ${params.maxImageBytes} bytes.`,
      { size: buffer.length, maxImageBytes: params.maxImageBytes },
    );
  }
  throwIfAborted(params.signal);
  const mimeType = inferMimeType(buffer);
  if (!mimeType) {
    throw new MoAgentToolError(
      'UNSUPPORTED_IMAGE',
      `Attachment is not a supported PNG, JPEG, GIF, or WebP image: ${resolved.relativePath}.`,
    );
  }
  const dimensions = readImageSize(buffer, mimeType);
  const boundedString = (value: unknown, label: string, maxLength: number): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > maxLength) {
      throw new MoAgentToolError(
        'INVALID_ATTACHMENT',
        `${label} must be a string of at most ${maxLength} characters.`,
      );
    }
    return value;
  };
  const id = boundedString(params.attachment.id, 'attachment.id', 128);
  const name = boundedString(params.attachment.name, 'attachment.name', 256);
  return {
    id: id || `image-${params.index + 1}`,
    name: name || path.basename(resolved.canonicalPath),
    path: resolved.canonicalRelativePath,
    url: boundedString(params.attachment.url, 'attachment.url', 2_048),
    publicUrl: boundedString(params.attachment.publicUrl, 'attachment.publicUrl', 2_048),
    mimeType,
    size: stat.size,
    width: dimensions.width,
    height: dimensions.height,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

function metadataPayload(params: {
  contextPath: string;
  prompt?: string;
  images: InspectedImage[];
  createdAt: Date;
}): ImageMetadataPayload {
  return {
    schemaVersion: 1,
    runtime: 'MoAgent',
    tool: 'image-extraction',
    status: 'metadata_ready',
    createdAt: params.createdAt.toISOString(),
    attachmentContextPath: params.contextPath,
    prompt: params.prompt ?? null,
    images: params.images,
    visualRecognition: {
      status: 'manual_confirmation_required',
      reason:
        'MoAgent 已确认图片文件、路径、格式、尺寸和哈希。当前未启用视觉模型或第三方 OCR，无法确认的截图字段必须交由用户确认。',
      fallbackRule:
        '所有无法可靠读取的截图字段必须保留 null，并在 evidence/data_quality.json 中列出需要用户确认的字段。',
    },
    imageExtraction: {
      source: 'uploaded_image',
      extractedFields: {
        account_total_asset: null,
        cash_available: null,
        market_value: null,
        daily_pnl: null,
        total_pnl: null,
        position_ratio: null,
        holdings: [],
      },
      needs_manual_confirmation: true,
      manual_confirmation_fields: PORTFOLIO_SCREENSHOT_FIELDS,
    },
    dashboardContract: {
      requiredFinalDataFields: ['portfolio', 'holdings', 'assets', 'comparison', 'imageExtraction'],
      evidenceFiles: [
        'evidence/image_extraction.json',
        'evidence/data_quality.json',
        'evidence/sources.json',
      ],
    },
  };
}

export async function extractUploadedImageMetadata(
  input: ImageExtractionInput,
  options: MoAgentImageExtractionToolOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<ImageExtractionPayload> {
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxAttachments = options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes <= 0) {
    throw new MoAgentToolError('INVALID_LIMIT', 'maxImageBytes must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxAttachments) || maxAttachments <= 0 || maxAttachments > 100) {
    throw new MoAgentToolError('INVALID_LIMIT', 'maxAttachments must be an integer between 1 and 100.');
  }
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1_024) {
    throw new MoAgentToolError('INVALID_LIMIT', 'maxOutputChars must be an integer of at least 1024.');
  }
  const policy = await MoAgentWorkspacePolicy.create({ workspaceRoot: options.workspaceRoot });
  throwIfAborted(signal);
  const requestedContextPath = input.attachmentContextPath ?? DEFAULT_ATTACHMENT_CONTEXT;
  let contextPath = requestedContextPath;
  let attachments: AttachmentRecord[];
  if (input.imagePath) {
    const requestedImagePath = pathForPolicy(policy.workspaceRoot, input.imagePath);
    attachments = [{ id: 'image-1', name: path.basename(input.imagePath), path: requestedImagePath }];
    contextPath = pathForPolicy(policy.workspaceRoot, requestedContextPath).replaceAll(path.sep, '/');
  } else {
    const context = await readAttachmentContext(policy, requestedContextPath);
    contextPath = context.contextPath;
    attachments = context.attachments;
  }
  if (attachments.length > maxAttachments) {
    throw new MoAgentToolError(
      'TOO_MANY_ATTACHMENTS',
      `Image extraction accepts at most ${maxAttachments} attachments.`,
      { count: attachments.length, maxAttachments },
    );
  }
  if (attachments.length === 0) {
    const payload: NoAttachmentsPayload = {
      schemaVersion: 1,
      runtime: 'MoAgent',
      tool: 'image-extraction',
      status: 'no_attachments',
      message: `未找到上传图片附件，请确认 ${contextPath} 是否包含 attachments。`,
    };
    return payload;
  }
  const images: InspectedImage[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    images.push(await inspectImage({
      policy,
      attachment: attachments[index],
      index,
      maxImageBytes,
      signal,
    }));
  }
  const payload = metadataPayload({
    contextPath,
    prompt: input.prompt,
    images,
    createdAt: options.now?.() ?? new Date(),
  });
  const payloadCharacters = JSON.stringify(payload).length;
  if (payloadCharacters > maxOutputChars) {
    throw new MoAgentToolError(
      'TOOL_OUTPUT_TOO_LARGE',
      `Image metadata output exceeds the MoAgent ${maxOutputChars}-character limit.`,
      { payloadCharacters, maxOutputChars, imageCount: images.length },
    );
  }
  return payload;
}

/** Native replacement for the former image MCP bridge. */
export function createImageExtractionTool(
  options: MoAgentImageExtractionToolOptions,
): MoAgentTool<ImageExtractionInput, ImageExtractionPayload> {
  return {
    name: 'quant_extract_uploaded_image',
    description:
      'Read QuantPilot uploaded-image attachments, verify the files inside the MoAgent workspace, and return the portfolio screenshot metadata/extraction contract. This tool performs no OCR and never invents uncertain fields.',
    effect: 'read',
    idempotency: 'intrinsic',
    inputSchema: {
      type: 'object',
      properties: {
        attachmentContextPath: {
          type: 'string',
          description: 'Workspace-relative attachment manifest path; defaults to .quantpilot/attachments.json.',
        },
        imagePath: {
          type: 'string',
          description: 'Optional single image path inside the workspace.',
        },
        prompt: {
          type: 'string',
          description: 'Information the user wants extracted from the image.',
        },
      },
      additionalProperties: false,
    },
    parseInput: parseImageExtractionInput,
    execute: (input, context) => executeMoAgentTool(
      context.signal,
      options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      async (signal) => {
        const data = await extractUploadedImageMetadata(input, options, signal);
        const content = data.status === 'metadata_ready'
          ? `MoAgent verified ${data.images.length} uploaded image(s). OCR is disabled; uncertain portfolio fields require manual confirmation.`
          : data.message;
        return {
          ok: true,
          data,
          content,
          metadata: {
            runtime: 'MoAgent',
            status: data.status,
            imageCount: data.status === 'metadata_ready' ? data.images.length : 0,
          },
        };
      },
    ),
  };
}
