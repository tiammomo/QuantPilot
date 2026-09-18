import path from 'path';
import { ensureBaselineEvidenceFiles } from '@/lib/quant/evidence';
import { readWorkspaceFileBounded, readWorkspaceJsonBounded } from '@/lib/data-agent/workspace-read';
import { assessQuantEvidence } from '@/lib/domains/finance/evidence-quality';
import { type QuantValidationCheck } from './contracts';
import { asRecord, hasAnyKeyDeep } from './inputs';

const SENSITIVE_EVIDENCE_PATTERN =
  /(?:sk-(?:proj|ant|cp|live|test)-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|(?:authorization|api[_-]?key|auth[_-]?token|cookie|set-cookie)\s*[:=]\s*["']?[a-z0-9._~+/=-]{12,})/i;

type EvidenceJsonResult =
  | { ok: true; parsed: unknown; raw: string; absolutePath: string }
  | { ok: false; error: string; absolutePath: string };

async function readEvidenceJson(
  projectPath: string,
  relativePath: string
): Promise<EvidenceJsonResult> {
  const absolutePath = path.join(projectPath, relativePath);
  try {
    const artifact = await readWorkspaceJsonBounded(projectPath, relativePath, 8 * 1024 * 1024);
    return { ok: true, parsed: artifact.value, raw: JSON.stringify(artifact.value), absolutePath };
  } catch {
    return {
      ok: false,
      error: `${relativePath} 缺失、超限或不是工作空间内可安全读取的 JSON 文件。`,
      absolutePath,
    };
  }
}

export async function checkEvidenceFiles(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const baseline = await ensureBaselineEvidenceFiles(projectPath);
  const sources = await readEvidenceJson(projectPath, path.join('evidence', 'sources.json'));
  const quality = await readEvidenceJson(projectPath, path.join('evidence', 'data_quality.json'));
  const errors: string[] = [];

  if (!sources.ok || !quality.ok) {
    const fileErrors = [
      sources.ok ? null : sources.error,
      quality.ok ? null : quality.error,
    ].filter((error): error is string => Boolean(error));
    return {
      status: 'failed',
      summary: '缺少数据信源渠道或数据质量证据文件。',
      details: fileErrors.join('\n'),
    };
  }

  const sourcesRaw = sources.raw;
  const qualityRaw = quality.raw;
  const combined = `${sourcesRaw}\n${qualityRaw}`;
  if (SENSITIVE_EVIDENCE_PATTERN.test(combined)) {
    return {
      status: 'failed',
      summary: 'evidence 文件疑似包含敏感信息。',
      details: '请移除任何鉴权凭据、会话凭据或密钥值，仅保留数据信源渠道、端点、时间戳和质量摘要。',
    };
  }

  const sourceEntries = asRecord(sources.parsed)?.sources;
  if (!Array.isArray(sourceEntries) || sourceEntries.length === 0) {
    errors.push('evidence/sources.json 必须包含非空 sources 数组。');
  }

  const serializedSources = JSON.stringify(sources.parsed);
  if (!/source|eastmoney|tencent|endpoint|fetched_at|as_of|quote_time|artifact_path/i.test(serializedSources)) {
    errors.push('evidence/sources.json 未检测到 source、endpoint、fetched_at/as_of 或 artifact_path 等来源字段。');
  }

  const qualityRecord = asRecord(quality.parsed);
  const assessment = assessQuantEvidence(sources.parsed, quality.parsed);
  errors.push(...assessment.failures);
  for (const artifactPath of assessment.artifactPaths) {
    try {
      const artifact = await readWorkspaceFileBounded(projectPath, artifactPath, 8 * 1024 * 1024);
      if (!artifact.bytes) errors.push(`来源产物为空：${artifactPath}`);
    } catch { errors.push(`来源产物缺失、超限或路径不安全：${artifactPath}`); }
  }
  const qualityStatus = typeof qualityRecord?.status === 'string' ? qualityRecord.status : null;
  if (!qualityStatus || !['ok', 'warning', 'error'].includes(qualityStatus)) {
    errors.push('evidence/data_quality.json 必须包含 status，取值为 ok、warning 或 error。');
  }

  const hasQualitySignals =
    hasAnyKeyDeep(quality.parsed, ['datasets', 'checks', 'missing_fields', 'warnings', 'limitations', 'row_count', 'fetched_at']) ||
    /row_count|missing_fields|warnings|limitations|fetched_at|样本|缺失|限制/i.test(JSON.stringify(quality.parsed));
  if (!hasQualitySignals) {
    errors.push('evidence/data_quality.json 未检测到数据集、检查项、缺失字段、警告或限制说明。');
  }

  if (errors.length > 0) {
    return {
      status: 'failed',
      summary: '数据信源渠道或质量证据不完整。',
      details: errors.join('\n'),
    };
  }

  const hasWarnings = qualityStatus === 'warning' || assessment.warnings.length > 0;
  const warningSummary = hasWarnings ? '数据质量或来源时间存在警告，页面应展示限制说明。' : undefined;
  return {
    status: qualityStatus === 'error' ? 'failed' : hasWarnings ? 'warning' : 'passed',
    summary: baseline.created
      ? `已根据最终数据自动生成数据信源渠道和质量证据文件，状态：${qualityStatus}。`
      : warningSummary ?? '已找到数据信源渠道和质量证据文件。',
    metadata: {
      sources: 'evidence/sources.json',
      dataQuality: 'evidence/data_quality.json',
      qualityStatus,
      sourceCount: Array.isArray(sourceEntries) ? sourceEntries.length : 0,
      baselineCreated: baseline.created,
      baselineReason: baseline.reason,
      evidenceWarnings: assessment.warnings,
    },
  };
}
