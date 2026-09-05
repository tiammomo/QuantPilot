import fs from 'fs/promises';
import path from 'path';
import { serializeMessage } from '@/lib/serializers/chat';
import { createMessage } from '@/lib/services/message';
import { streamManager } from '@/lib/services/stream';
import { ensureQuantWorkspace } from '@/lib/domains/finance/workspace';
import {
  type QuantValidationArtifactMtime,
  type QuantValidationFreshness,
  type QuantValidationRepairPlan,
  type QuantValidationReport,
  type QuantValidationStaleReason,
  VALIDATION_REPAIR_PLAN_RELATIVE_PATH,
  VALIDATION_STALE_ARTIFACT_PATHS,
  type ValidateQuantProjectParams,
} from './contracts';
import { formatDuration, readTextFile, validationRepairPlanPath, validationReportPath } from './files';
import { readCurrentQuantRunId } from './inputs';

/**
 * Pure validation-report freshness contract. A report belongs only to the
 * generation run that produced it and only covers artifacts that are no newer
 * than the report itself.
 */
export function assessQuantValidationReportFreshness(params: {
  reportRunId?: string | null;
  currentRunId?: string | null;
  reportMtimeMs: number;
  artifacts: QuantValidationArtifactMtime[];
}): QuantValidationFreshness {
  const reportRunId = params.reportRunId?.trim() || null;
  const currentRunId = params.currentRunId?.trim() || null;
  const staleArtifacts = params.artifacts.filter(
    (artifact) =>
      Number.isFinite(artifact.mtimeMs) &&
      artifact.mtimeMs > params.reportMtimeMs,
  );
  const reasons: QuantValidationStaleReason[] = [];

  if (staleArtifacts.length > 0) {
    reasons.push('artifact_modified_after_report');
  }
  if (currentRunId && reportRunId !== currentRunId) {
    reasons.push('run_id_mismatch');
  }

  return {
    stale: reasons.length > 0,
    reasons,
    staleArtifactPaths: staleArtifacts.map((artifact) => artifact.path),
    newestArtifactMtimeMs:
      staleArtifacts.length > 0
        ? Math.max(...staleArtifacts.map((artifact) => artifact.mtimeMs))
        : null,
    reportRunId,
    currentRunId,
  };
}

export async function writeValidationReport(projectPath: string, report: QuantValidationReport) {
  await ensureQuantWorkspace(projectPath);
  await fs.writeFile(validationReportPath(projectPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function buildValidationSummary(report: QuantValidationReport): string {
  const passedCount = report.checks.filter((check) => check.status === 'passed').length;
  const failedChecks = report.checks.filter((check) => check.status === 'failed');
  const warningChecks = report.checks.filter((check) => check.status === 'warning');
  const headline = report.passed
    ? `自动验证通过：${passedCount}/${report.checks.length} 项检查通过。`
    : `自动验证未通过：${passedCount}/${report.checks.length} 项检查通过，${failedChecks.length} 项失败。`;

  const lines = [
    headline,
    '',
    ...report.checks.map((check) => {
      const mark = check.status === 'passed' ? '通过' : check.status === 'warning' ? '警告' : '失败';
      const duration = check.durationMs ? `（${formatDuration(check.durationMs)}）` : '';
      return `- ${mark}：${check.name}${duration} - ${check.summary}`;
    }),
    '',
    `验证报告：${report.reportPath}`,
  ];

  if (!report.passed) {
    lines.push(`修复计划：${VALIDATION_REPAIR_PLAN_RELATIVE_PATH}`);
  }

  if (warningChecks.length > 0) {
    lines.push(`警告项：${warningChecks.map((check) => check.name).join('、')}`);
  }

  return lines.join('\n');
}

export async function publishValidationSummary(
  params: ValidateQuantProjectParams,
  report: QuantValidationReport
) {
  const content = buildValidationSummary(report);

  try {
    const savedMessage = await createMessage({
      projectId: params.projectId,
      role: 'assistant',
      messageType: 'chat',
      content,
      conversationId: params.conversationId ?? null,
      cliSource: params.cliSource ?? 'validator',
      requestId: params.requestId ?? undefined,
      metadata: {
        toolName: 'QuantPilot 自动验证',
        isMissionIntermediate: true,
        validationStatus: report.status,
        reportPath: report.reportPath,
        checks: report.checks.map((check) => ({
          id: check.id,
          name: check.name,
          status: check.status,
          summary: check.summary,
        })),
      },
    });

    streamManager.publish(params.projectId, {
      type: 'message',
      data: serializeMessage(savedMessage, {
        requestId: params.requestId ?? undefined,
        isFinal: true,
      }),
    });
  } catch (error) {
    console.error('[QuantValidation] Failed to persist validation summary:', error);
  }
}

export async function readQuantValidationReport(projectPath: string): Promise<QuantValidationReport | null> {
  const resolvedProjectPath = path.resolve(/*turbopackIgnore: true*/ projectPath);
  const reportPath = validationReportPath(resolvedProjectPath);
  const report = await readTextFile(reportPath);
  if (!report) {
    return null;
  }

  try {
    const parsed = JSON.parse(report) as QuantValidationReport;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const [reportStat, artifactStats, currentRunId] = await Promise.all([
      fs.stat(reportPath).catch(() => null),
      Promise.all(
        VALIDATION_STALE_ARTIFACT_PATHS.map(async (relativePath) => {
          const stat = await fs
            .stat(path.join(resolvedProjectPath, relativePath))
            .catch(() => null);
          return stat?.isFile()
            ? { path: relativePath, mtimeMs: stat.mtimeMs }
            : null;
        }),
      ),
      readCurrentQuantRunId(resolvedProjectPath),
    ]);
    if (reportStat) {
      const freshness = assessQuantValidationReportFreshness({
        reportRunId: parsed.runId,
        currentRunId,
        reportMtimeMs: reportStat.mtimeMs,
        artifacts: artifactStats.filter(
          (artifact): artifact is QuantValidationArtifactMtime => artifact !== null,
        ),
      });
      if (freshness.stale) {
        const staleBecauseRunChanged = freshness.reasons.includes('run_id_mismatch');
        const staleBecauseArtifactsChanged = freshness.reasons.includes(
          'artifact_modified_after_report',
        );
        return {
          ...parsed,
          checks: [
            ...(Array.isArray(parsed.checks) ? parsed.checks : []),
            {
              id: 'validation_report_stale',
              name: '验证报告已过期',
              status: 'warning',
              summary:
                staleBecauseRunChanged && staleBecauseArtifactsChanged
                  ? '当前生成轮次和关键产物均已变化，需要重新运行自动验证。'
                  : staleBecauseRunChanged
                    ? '验证报告不属于当前生成轮次，需要重新运行自动验证。'
                    : '生成产物在上次验证后发生变化，需要重新运行自动验证。',
              metadata: {
                reasons: freshness.reasons,
                reportUpdatedAt: reportStat.mtime.toISOString(),
                staleArtifactPaths: freshness.staleArtifactPaths,
                reportRunId: freshness.reportRunId,
                currentRunId: freshness.currentRunId,
                ...(freshness.newestArtifactMtimeMs !== null
                  ? {
                      newestArtifactUpdatedAt: new Date(
                        freshness.newestArtifactMtimeMs,
                      ).toISOString(),
                    }
                  : {}),
              },
            },
          ],
        };
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readQuantValidationRepairPlan(projectPath: string): Promise<QuantValidationRepairPlan | null> {
  const report = await readTextFile(
    validationRepairPlanPath(path.resolve(/*turbopackIgnore: true*/ projectPath))
  );
  if (!report) {
    return null;
  }

  try {
    const parsed = JSON.parse(report) as QuantValidationRepairPlan;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
