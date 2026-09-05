import { streamManager } from '@/lib/services/stream';
import { appendQuantWorkspaceEvent } from '@/lib/domains/finance/workspace';
import {
  type QuantValidationCheck,
  type QuantValidationReport,
  VALIDATION_REPORT_RELATIVE_PATH,
  type ValidateQuantProjectParams,
} from './validation/contracts';
import { prepareQuantProjectForValidation } from './validation/preparation';
import {
  checkBuild,
  checkMarketProxy,
  checkPreviewHttp,
  checkVisualPresentation,
  stopPreviewForValidation,
} from './validation/runtime-checks';
import { safeRunCheck } from './validation/files';
import { checkArtifactPolicy } from './validation/artifact-policy';
import { checkArtifactContracts, checkFinalDataFile } from './validation/data-checks';
import { checkEvidenceFiles } from './validation/evidence-checks';
import { checkChartPresence, checkDashboardBinding } from './validation/dashboard-checks';
import { readCurrentQuantRunId } from './validation/inputs';
import { publishValidationSummary, writeValidationReport } from './validation/reports';
import { writeValidationRepairPlan } from './validation/repair';

const validationQueues = new Map<string, Promise<void>>();

export async function validateQuantProject(params: ValidateQuantProjectParams): Promise<QuantValidationReport> {
  return withProjectValidationLock(params.projectId, () => validateQuantProjectUnlocked(params));
}

async function withProjectValidationLock<T>(
  projectId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = validationQueues.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  validationQueues.set(projectId, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (validationQueues.get(projectId) === queued) {
      validationQueues.delete(projectId);
    }
  }
}

async function validateQuantProjectUnlocked(params: ValidateQuantProjectParams): Promise<QuantValidationReport> {
  const projectPath = await prepareQuantProjectForValidation(params);
  const now = new Date().toISOString();

  await stopPreviewForValidation(params.projectId).catch((error) => {
    console.warn(
      '[QuantValidation] Failed to stop preview before validation build:',
      error
    );
  });
  await appendQuantWorkspaceEvent(projectPath, {
    event_type: 'validation_started',
    stage: 'validation',
    status: 'pending',
    run_id: params.requestId ?? undefined,
    summary: '开始自动验证：build、HTTP 200、最终数据文件、evidence、产物策略、图表和 /api/market 代理。',
    created_at: now,
  });

  streamManager.publish(params.projectId, {
    type: 'status',
    data: {
      status: 'validation_running',
      message: '正在执行自动验证：build、HTTP 200、数据文件、evidence、产物策略、图表和 /api/market 代理。',
      requestId: params.requestId ?? undefined,
    },
  });

  const checks: QuantValidationCheck[] = [];
  try {
    const artifactPolicy = await safeRunCheck(
      'artifact_policy',
      '生成产物策略',
      () => checkArtifactPolicy(projectPath),
    );
    checks.push(artifactPolicy);
    if (artifactPolicy.status !== 'failed') {
      checks.push(await safeRunCheck('next_build', 'Next.js build', () => checkBuild(projectPath)));
      checks.push(await safeRunCheck('preview_http_200', '预览 HTTP 200', () => checkPreviewHttp(params.projectId)));
      checks.push(await safeRunCheck('visual_presentation', '视觉验收', () => checkVisualPresentation(projectPath, params.projectId, params.requestId)));
    } else {
      for (const [id, name] of [
        ['next_build', 'Next.js build'],
        ['preview_http_200', '预览 HTTP 200'],
        ['visual_presentation', '视觉验收'],
      ] as const) {
        checks.push({
          id,
          name,
          status: 'warning',
          summary: '生成产物安全预检失败，已跳过可执行检查。',
          details: '修复 artifact_policy 后才会执行生成代码。',
          durationMs: 0,
        });
      }
    }
    checks.push(await safeRunCheck('final_data_file', '最终数据文件', () => checkFinalDataFile(projectPath)));
    checks.push(await safeRunCheck('evidence_files', '数据证据文件', () => checkEvidenceFiles(projectPath)));
    checks.push(await safeRunCheck('artifact_contracts', '产物 Schema 契约', () => checkArtifactContracts(projectPath, params.projectId, params.requestId)));
    checks.push(await safeRunCheck('dashboard_data_binding', '页面数据绑定', () => checkDashboardBinding(projectPath)));
    checks.push(await safeRunCheck('chart_presence', '金融图表存在性', () => checkChartPresence(projectPath)));
    checks.push(await safeRunCheck('market_proxy', '/api/market 代理', () => checkMarketProxy(projectPath, params.projectId)));
  } finally {
    await stopPreviewForValidation(params.projectId).catch((error) => {
      console.warn(
        '[QuantValidation] Failed to stop temporary preview after validation:',
        error
      );
    });
  }

  const passed = checks.every((check) => check.status !== 'failed');
  const updatedAt = new Date().toISOString();
  const reportRunId = params.requestId ?? await readCurrentQuantRunId(projectPath);
  const report: QuantValidationReport = {
    schemaVersion: 1,
    runId: reportRunId ?? undefined,
    status: passed ? 'passed' : 'failed',
    passed,
    projectId: params.projectId,
    reportPath: VALIDATION_REPORT_RELATIVE_PATH,
    checks,
    createdAt: now,
    updatedAt,
  };

  await writeValidationReport(projectPath, report);
  await writeValidationRepairPlan(projectPath, report);
  await appendQuantWorkspaceEvent(projectPath, {
    event_type: 'validation_completed',
    stage: 'validation',
    status: passed ? 'success' : 'error',
    run_id: params.requestId ?? undefined,
    artifact_path: VALIDATION_REPORT_RELATIVE_PATH,
    summary: passed ? '自动验证通过。' : `自动验证未通过：${checks.filter((check) => check.status === 'failed').length} 项失败。`,
    created_at: updatedAt,
  });

  streamManager.publish(params.projectId, {
    type: 'status',
    data: {
      status: passed ? 'validation_checks_passed' : 'validation_failed',
      message: passed
        ? '自动验证检查已通过，正在等待独立证据验收。'
        : '自动验证未通过，请查看验证摘要。',
      requestId: params.requestId ?? undefined,
      metadata: {
        reportPath: VALIDATION_REPORT_RELATIVE_PATH,
        checks: checks.map((check) => ({
          id: check.id,
          status: check.status,
          summary: check.summary,
        })),
      },
    },
  });

  await publishValidationSummary(params, report);

  return report;
}
