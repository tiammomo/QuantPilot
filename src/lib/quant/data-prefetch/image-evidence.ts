import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { appendQuantWorkspaceEvent } from '@/lib/domains/finance/workspace';
import { type JsonRecord, asRecord } from './values';
import { readJson, writeJson } from './transport';

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveInsideProject(projectPath: string, inputPath: string): string {
  if (path.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath)) {
    throw new Error(`附件路径必须使用工作空间相对路径：${inputPath}`);
  }
  const resolved = path.resolve(projectPath, inputPath);
  if (!isInside(projectPath, resolved)) {
    throw new Error(`附件路径必须位于当前生成项目内：${inputPath}`);
  }
  return resolved;
}

function inferImageMimeType(filePath: string, buffer: Buffer): string {
  const lower = filePath.toLowerCase();
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || lower.endsWith('.png')) {
    return 'image/png';
  }
  if ((buffer[0] === 0xff && buffer[1] === 0xd8) || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF' || lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return 'application/octet-stream';
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
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      const isSofMarker = [
        0xc0,
        0xc1,
        0xc2,
        0xc3,
        0xc5,
        0xc6,
        0xc7,
        0xc9,
        0xca,
        0xcb,
        0xcd,
        0xce,
        0xcf,
      ].includes(marker);
      if (isSofMarker && offset + 8 < buffer.length) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += Math.max(2 + length, 2);
    }
  }

  return { width: null, height: null };
}

const PORTFOLIO_IMAGE_FIELDS = [
  'account_total_asset',
  'cash_available',
  'market_value',
  'daily_pnl',
  'total_pnl',
  'position_ratio',
  'holdings[].name',
  'holdings[].quantity',
  'holdings[].cost_price',
  'holdings[].current_price',
  'holdings[].market_value',
  'holdings[].pnl',
  'holdings[].pnl_percent',
];

export async function buildImageExtractionEvidence(
  projectPath: string,
  runId: string,
  warnings: string[]
): Promise<JsonRecord | null> {
  const contextPath = path.join(projectPath, '.data-agent', 'attachments.json');
  const context = await readJson(contextPath);
  const attachments = Array.isArray(context?.attachments)
    ? context.attachments.map(asRecord).filter((item): item is JsonRecord => Boolean(item))
    : [];

  if (attachments.length === 0) {
    return null;
  }

  const images: JsonRecord[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const sourcePath = typeof attachment.path === 'string' ? attachment.path : null;

    if (!sourcePath) {
      warnings.push(`上传图片附件 ${String(attachment.name ?? index + 1)} 缺少工作空间相对 path。`);
      continue;
    }

    try {
      const absolutePath = resolveInsideProject(projectPath, sourcePath);
      const buffer = await fs.readFile(absolutePath);
      const stat = await fs.stat(absolutePath);
      const mimeType =
        typeof attachment.mimeType === 'string' && attachment.mimeType.trim()
          ? attachment.mimeType.trim()
          : inferImageMimeType(absolutePath, buffer);
      const size = readImageSize(buffer, mimeType);
      images.push({
        id: String(attachment.id ?? `image-${index + 1}`),
        name: String(attachment.name ?? path.basename(absolutePath)),
        path: path.relative(projectPath, absolutePath).replaceAll(path.sep, '/'),
        url: typeof attachment.url === 'string' ? attachment.url : null,
        publicUrl: typeof attachment.publicUrl === 'string' ? attachment.publicUrl : null,
        mimeType,
        size: stat.size,
        width: size.width,
        height: size.height,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      });
    } catch (error) {
      warnings.push(
        `上传图片附件 ${String(attachment.name ?? sourcePath)} 检查失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (images.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    tool: 'image-extraction',
    status: 'metadata_ready',
    createdAt: now,
    runId,
    attachmentContextPath: '.data-agent/attachments.json',
    images,
    visualRecognition: {
      status: 'requires_vision_provider',
      reason: '平台已确认图片文件、格式、尺寸和哈希；若当前模型或工具不能直接 OCR，必须保留截图字段缺口并要求用户确认。',
      fallbackRule: '不得编造持仓数量、成本、现金、盈亏和仓位比例；未识别字段必须写入 data_gaps 和 evidence/data_quality.json。',
    },
    imageExtraction: {
      source: 'uploaded_image',
      extracted_at: now,
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
      manual_confirmation_fields: PORTFOLIO_IMAGE_FIELDS,
    },
    dashboardContract: {
      requiredFinalDataFields: ['portfolio', 'holdings', 'assets', 'comparison', 'imageExtraction'],
      evidenceFiles: ['evidence/image_extraction.json', 'evidence/data_quality.json', 'evidence/sources.json'],
    },
  };

  await writeJson(path.join(projectPath, 'evidence', 'image_extraction.json'), payload);
  await appendQuantWorkspaceEvent(projectPath, {
    event_type: 'image_attachment_evidence_created',
    stage: 'data_collection',
    status: 'warning',
    run_id: runId,
    artifact_path: 'evidence/image_extraction.json',
    summary: '已为上传图片生成附件证据和截图识别契约；未确认字段需要在看板中标注。',
    created_at: now,
  });
  warnings.push('上传图片已建立附件证据；截图 OCR 字段未完全确认，页面必须展示数据缺口和人工确认要求。');
  return payload;
}

export async function augmentEvidenceWithImageExtraction(projectPath: string, imageExtractionEvidence: JsonRecord) {
  const createdAt = typeof imageExtractionEvidence.createdAt === 'string'
    ? imageExtractionEvidence.createdAt
    : new Date().toISOString();
  const images = Array.isArray(imageExtractionEvidence.images) ? imageExtractionEvidence.images : [];
  const qualityPath = path.join(projectPath, 'evidence', 'data_quality.json');
  const sourcesPath = path.join(projectPath, 'evidence', 'sources.json');
  const quality = (await readJson(qualityPath)) ?? {};
  const sources = (await readJson(sourcesPath)) ?? {};
  const dataset = {
    id: 'uploaded_image_attachment',
    name: '用户上传持仓截图',
    source: 'uploaded_image',
    endpoint: 'UPLOAD .data-agent/attachments.json',
    artifact_path: 'evidence/image_extraction.json',
    row_count: images.length,
    fetched_at: createdAt,
    as_of: createdAt,
    missing_fields: PORTFOLIO_IMAGE_FIELDS,
    warnings: ['截图文件已确认，但 OCR 字段需要模型或用户继续确认，不允许编造持仓明细。'],
    status: 'warning',
    required: true,
  };

  quality.status = quality.status === 'error' ? 'error' : 'warning';
  const qualityDatasets = Array.isArray(quality.datasets) ? quality.datasets : [];
  if (!qualityDatasets.some((item) => asRecord(item)?.id === dataset.id)) {
    qualityDatasets.push(dataset);
  }
  quality.datasets = qualityDatasets;

  const qualityChecks = Array.isArray(quality.checks) ? quality.checks : [];
  if (!qualityChecks.some((item) => asRecord(item)?.id === 'uploaded_image_attachment_quality')) {
    qualityChecks.push({
      id: 'uploaded_image_attachment_quality',
      dataset: dataset.id,
      status: 'warning',
      row_count: images.length,
      missing_fields: PORTFOLIO_IMAGE_FIELDS,
      summary: '用户上传截图已进入证据链，关键持仓字段仍需 OCR 或用户确认。',
    });
  }
  quality.checks = qualityChecks;

  const qualityWarnings = Array.isArray(quality.warnings) ? quality.warnings : [];
  qualityWarnings.push('用户上传截图字段未完全结构化，调仓分析需显式标注截图识别边界。');
  quality.warnings = qualityWarnings;

  const qualityLimitations = Array.isArray(quality.limitations) ? quality.limitations : [];
  qualityLimitations.push('截图类任务必须区分图片元数据、行情接口数据和模型推断，不能把未确认字段当作真实持仓。');
  quality.limitations = qualityLimitations;

  const sourceRows = Array.isArray(sources.sources) ? sources.sources : [];
  if (!sourceRows.some((item) => asRecord(item)?.id === dataset.id)) {
    sourceRows.push({
      id: dataset.id,
      dataset: dataset.name,
      source: dataset.source,
      endpoint: dataset.endpoint,
      artifact_path: dataset.artifact_path,
      row_count: dataset.row_count,
      fetched_at: dataset.fetched_at,
      as_of: dataset.as_of,
      status: dataset.status,
    });
  }
  sources.sources = sourceRows;

  await Promise.all([
    writeJson(qualityPath, quality),
    writeJson(sourcesPath, sources),
  ]);
}
