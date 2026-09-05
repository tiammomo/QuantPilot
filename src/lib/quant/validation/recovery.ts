import fs from 'fs/promises';
import path from 'path';
import { appendQuantWorkspaceEvent, writeInitialRunPlan } from '@/lib/domains/finance/workspace';
import type { QuantQueryRewriteResult } from '@/lib/domains/finance/query-rewrite';
import { restoreQuantDashboardTemplate } from '@/lib/utils/scaffold';
import { type QuantDashboardTemplateRestoreResult, type QuantValidationReport } from './contracts';
import { readTextFile } from './files';

const DASHBOARD_TEMPLATE_RESTORE_CHECK_IDS = new Set([
  'next_build',
  'preview_http_200',
  'visual_presentation',
  'dashboard_data_binding',
  'chart_presence',
]);

const DASHBOARD_TEMPLATE_PROTECTED_ARTIFACT_PATHS = [
  '.data-agent/finance-run-plan.json',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data_quality.json',
] as const;

export async function repairQuantPlatformOwnedArtifacts(params: {
  projectPath: string;
  requestId: string;
  originalInstruction: string;
  report: QuantValidationReport;
  queryRewrite?: QuantQueryRewriteResult;
}): Promise<{ runPlanRebuilt: boolean }> {
  const platformFailureText = params.report.checks
    .filter((check) => check.status === 'failed')
    .map((check) => `${check.id}\n${check.summary}\n${check.details ?? ''}`)
    .join('\n');
  const runPlanNeedsPlatformRepair =
    /(?:run_plan|运行计划).*(?:缺失|无效|契约|不一致|误写|template)|(?:template|模板).*(?:run_plan|运行计划)/i.test(
      platformFailureText,
    );

  if (!runPlanNeedsPlatformRepair) {
    return { runPlanRebuilt: false };
  }

  await writeInitialRunPlan({
    projectPath: params.projectPath,
    instruction: params.originalInstruction,
    requestId: params.requestId,
    capabilitySource: 'inferred',
    queryRewrite: params.queryRewrite,
  });

  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: 'platform_artifact_repaired',
    stage: 'validation_repair',
    status: 'success',
    run_id: params.requestId,
    artifact_path: '.data-agent/finance-run-plan.json',
    summary: '平台已根据原始请求重建只读 run_plan，Agent 无需且不得修改 .data-agent。',
  });

  return { runPlanRebuilt: true };
}

export function isQuantDashboardTemplateRecoveryEligible(
  report: QuantValidationReport,
): boolean {
  if (report.passed || report.status !== 'failed') return false;
  const failedCheckIds = Array.from(new Set(
    report.checks
      .filter((check) => check.status === 'failed')
      .map((check) => check.id),
  ));
  return failedCheckIds.length > 0 && failedCheckIds.every(
    (checkId) => DASHBOARD_TEMPLATE_RESTORE_CHECK_IDS.has(checkId),
  );
}

/**
 * Deterministic recovery for an exhausted or provably stalled Agent repair.
 * The platform template may replace the generated page only when every blocking
 * check is presentation related; data, evidence, contract, policy, or proxy
 * failures must be repaired without overwriting the page.
 */
export async function restoreQuantDashboardTemplateAfterRepairExhaustion(params: {
  projectPath: string;
  report: QuantValidationReport;
}): Promise<QuantDashboardTemplateRestoreResult> {
  const failedCheckIds = Array.from(
    new Set(
      params.report.checks
        .filter((check) => check.status === 'failed')
        .map((check) => check.id),
    ),
  );

  if (params.report.passed || params.report.status !== 'failed') {
    return {
      restored: false,
      reason: '验证报告未处于失败状态，无需恢复平台看板模板。',
      failedCheckIds,
    };
  }

  if (failedCheckIds.length === 0) {
    return {
      restored: false,
      reason: '验证报告没有阻断性失败项，未恢复平台看板模板。',
      failedCheckIds,
    };
  }

  const nonPresentationCheckIds = failedCheckIds.filter(
    (checkId) => !DASHBOARD_TEMPLATE_RESTORE_CHECK_IDS.has(checkId),
  );
  if (nonPresentationCheckIds.length > 0) {
    return {
      restored: false,
      reason: `存在非页面类失败项（${nonPresentationCheckIds.join('、')}），为避免覆盖有效页面，未恢复平台看板模板。`,
      failedCheckIds,
    };
  }

  const projectPath = path.resolve(/*turbopackIgnore: true*/ params.projectPath);
  const protectedArtifacts = await Promise.all(
    DASHBOARD_TEMPLATE_PROTECTED_ARTIFACT_PATHS.map(async (relativePath) => ({
      relativePath,
      content: await readTextFile(path.join(projectPath, relativePath)),
    })),
  );
  const missingProtectedArtifacts = protectedArtifacts
    .filter((artifact) => artifact.content === null)
    .map((artifact) => artifact.relativePath);
  if (missingProtectedArtifacts.length > 0) {
    return {
      restored: false,
      reason: `缺少恢复所需的只读数据产物（${missingProtectedArtifacts.join('、')}），未恢复平台看板模板。`,
      failedCheckIds,
    };
  }

  let restoreFailure: string | null = null;
  try {
    await restoreQuantDashboardTemplate(projectPath);
  } catch (error) {
    restoreFailure = error instanceof Error ? error.message : String(error);
  }

  const changedProtectedArtifacts: Array<{ relativePath: string; content: string }> = [];
  for (const artifact of protectedArtifacts) {
    const content = artifact.content as string;
    const currentContent = await readTextFile(path.join(projectPath, artifact.relativePath));
    if (currentContent !== content) {
      changedProtectedArtifacts.push({ relativePath: artifact.relativePath, content });
    }
  }

  if (changedProtectedArtifacts.length > 0) {
    const rollbackFailures: string[] = [];
    for (const artifact of changedProtectedArtifacts) {
      try {
        const absolutePath = path.join(projectPath, artifact.relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, artifact.content, 'utf8');
      } catch {
        rollbackFailures.push(artifact.relativePath);
      }
    }
    const changedPaths = changedProtectedArtifacts.map((artifact) => artifact.relativePath).join('、');
    return {
      restored: false,
      reason: rollbackFailures.length > 0
        ? `模板恢复意外改动了受保护产物（${changedPaths}），且回滚失败：${rollbackFailures.join('、')}。`
        : `模板恢复意外改动了受保护产物（${changedPaths}），已回滚数据产物并拒绝标记为恢复成功。`,
      failedCheckIds,
    };
  }

  if (restoreFailure) {
    return {
      restored: false,
      reason: `平台看板模板恢复失败：${restoreFailure}`,
      failedCheckIds,
    };
  }

  return {
    restored: true,
    reason: `仅检测到页面类失败项（${failedCheckIds.join('、')}），已恢复平台看板模板；final 与 evidence 保持不变，需重新运行验证。`,
    failedCheckIds,
  };
}
